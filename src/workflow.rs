use std::{
    collections::{HashMap, HashSet},
    fmt,
    sync::Arc,
    time::{Duration, SystemTime},
};

use graph_flow::{FlowRunner, InMemorySessionStorage, Session, SessionStorage};
use graph_flow_jcode::{JCODE_SESSION_KEY, JcodeRuntime};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock, broadcast};
use uuid::Uuid;

use crate::{
    RunId, RunSnapshot, RunStatus, RunTrigger, WorkflowDefinition, WorkflowError,
    WorkflowExecutionLimits,
    workflows::{
        INPUT_SUMMARY_KEY, WORKFLOW_INPUT_KEY, build_graph, definition, parse_input,
        workflow_definitions,
    },
};

#[path = "workflow/driver.rs"]
mod driver;
#[path = "workflow/events.rs"]
mod events;
#[path = "workflow/history.rs"]
mod history;

use driver::drive;
pub use events::WorkflowEvent;
use history::{HISTORY_JOURNAL_CAPACITY, HistoryState};
pub use history::{HistoryDelta, HistoryReplay, HistoryRevision, HistoryView, RunListProjection};

/// Cloneable local boundary for workflow starts, listing, and event subscription.
#[derive(Clone)]
pub struct WorkflowService {
    inner: Arc<Inner>,
}

impl fmt::Debug for WorkflowService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkflowService")
            .finish_non_exhaustive()
    }
}

struct Inner {
    runtimes: HashMap<&'static str, WorkflowRuntime>,
    history: RwLock<HistoryState>,
    events: broadcast::Sender<WorkflowEvent>,
    history_events: broadcast::Sender<HistoryDelta>,
    running_schedules: Mutex<HashSet<String>>,
}

struct WorkflowRuntime {
    definition: &'static WorkflowDefinition,
    limits: WorkflowExecutionLimits,
    runner: FlowRunner,
    storage: Arc<InMemorySessionStorage>,
}

impl WorkflowService {
    /// Start one shared jcode process and build every code-defined workflow.
    pub fn new() -> Result<Self, WorkflowError> {
        let runtime = crate::workflows::launch_jcode_runtime()?;
        Self::build(Some(&runtime))
    }

    /// Build the workflow catalog without starting jcode for non-agent tests.
    #[doc(hidden)]
    pub fn without_jcode_runtime() -> Result<Self, WorkflowError> {
        Self::build(None)
    }

    fn build(jcode_runtime: Option<&Arc<JcodeRuntime>>) -> Result<Self, WorkflowError> {
        crate::workflow_scheduler::validate_schedules()?;
        let mut runtimes = HashMap::new();
        for definition in workflow_definitions() {
            let limits = definition.execution_limits()?;
            let graph = Arc::new(build_graph(
                definition.workflow_id,
                jcode_runtime.map(Arc::clone),
            )?);
            let storage = Arc::new(InMemorySessionStorage::new());
            let session_storage: Arc<dyn SessionStorage> =
                Arc::<InMemorySessionStorage>::clone(&storage);
            runtimes.insert(
                definition.workflow_id,
                WorkflowRuntime {
                    definition,
                    limits,
                    runner: FlowRunner::new(graph, session_storage),
                    storage,
                },
            );
        }
        let (events, _) = broadcast::channel(128);
        let (history_events, _) = broadcast::channel(HISTORY_JOURNAL_CAPACITY);
        Ok(Self {
            inner: Arc::new(Inner {
                runtimes,
                history: RwLock::new(HistoryState::new()),
                events,
                history_events,
                running_schedules: Mutex::new(HashSet::new()),
            }),
        })
    }

    /// Validate a workflow ID, retain its first snapshot, and start its driver.
    pub async fn start(
        &self,
        workflow_id: &str,
        raw_input: Value,
        trigger: RunTrigger,
    ) -> Result<RunSnapshot, WorkflowError> {
        let definition = definition(workflow_id).ok_or_else(|| WorkflowError::UnknownWorkflow {
            workflow_id: workflow_id.to_owned(),
        })?;
        let runtime =
            self.inner
                .runtimes
                .get(workflow_id)
                .ok_or_else(|| WorkflowError::UnknownWorkflow {
                    workflow_id: workflow_id.to_owned(),
                })?;
        let input = parse_input(workflow_id, raw_input)?;
        let run_id = RunId(Uuid::new_v4().to_string());
        let session = Session::new_from_task(run_id.0.clone(), definition.start_node)
            .with_graph_id(definition.workflow_id);
        session
            .context
            .set(WORKFLOW_INPUT_KEY, input.state())
            .map_err(|error| session_error(&error))?;
        session
            .context
            .set(INPUT_SUMMARY_KEY, input.summary())
            .map_err(|error| session_error(&error))?;
        session
            .context
            .set(JCODE_SESSION_KEY, run_id.as_str())
            .map_err(|error| session_error(&error))?;
        runtime
            .storage
            .save(session)
            .await
            .map_err(|error| session_error(&error))?;
        let snapshot = RunSnapshot {
            run_id: run_id.clone(),
            workflow_id: definition.workflow_id.to_owned(),
            input,
            trigger,
            status: RunStatus::Running,
            current_node: Some(definition.start_node.to_owned()),
            current_edge: None,
            traversed_nodes: Vec::new(),
            traversed_edges: Vec::new(),
            route_summary: definition.start_node.to_owned(),
            started_at: SystemTime::now(),
            finished_at: None,
            duration: None,
            steps: Vec::new(),
        };
        let delta = self.inner.history.write().await.insert(snapshot.clone());
        let _ = self.inner.history_events.send(delta);
        let _ = self.inner.events.send(WorkflowEvent::RunStarted {
            run_id: run_id.clone(),
            workflow_id: definition.workflow_id.to_owned(),
        });
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move { drive(inner, run_id, definition.workflow_id).await });
        Ok(snapshot)
    }

    /// Subscribe to future workflow lifecycle notifications.
    pub fn subscribe(&self) -> broadcast::Receiver<WorkflowEvent> {
        self.inner.events.subscribe()
    }

    /// Subscribe to future atomic history changes.
    pub fn subscribe_history(&self) -> broadcast::Receiver<HistoryDelta> {
        self.inner.history_events.subscribe()
    }

    /// Read every retained run and its shared revision atomically.
    pub async fn history_view(&self) -> HistoryView {
        self.inner.history.read().await.view()
    }

    /// Replay retained changes after a previously observed revision.
    pub async fn history_since(&self, after: HistoryRevision) -> HistoryReplay {
        self.inner.history.read().await.replay(after)
    }

    /// Read the current view and its replay boundary under one history lock.
    pub async fn history_view_since(&self, after: HistoryRevision) -> (HistoryView, HistoryReplay) {
        let history = self.inner.history.read().await;
        (history.view(), history.replay(after))
    }

    /// List all retained snapshots in start order.
    pub async fn list_runs(&self) -> Vec<RunSnapshot> {
        self.inner.history.read().await.view().runs
    }

    /// Poll one retained snapshot by its opaque run ID.
    pub async fn get_run(&self, run_id: &RunId) -> Option<RunSnapshot> {
        self.inner.history.read().await.get(run_id)
    }

    pub(crate) async fn claim_schedule(&self, schedule_id: &str) -> bool {
        self.inner
            .running_schedules
            .lock()
            .await
            .insert(schedule_id.to_owned())
    }

    pub(crate) async fn release_schedule(&self, schedule_id: &str) {
        self.inner
            .running_schedules
            .lock()
            .await
            .remove(schedule_id);
    }

    pub(crate) async fn retain_skipped_schedule(
        &self,
        workflow_id: &str,
        raw_input: Value,
        trigger: RunTrigger,
        reason: &str,
    ) -> Result<RunSnapshot, WorkflowError> {
        let input = parse_input(workflow_id, raw_input)?;
        let now = SystemTime::now();
        let snapshot = RunSnapshot {
            run_id: RunId(Uuid::new_v4().to_string()),
            workflow_id: workflow_id.to_owned(),
            input,
            trigger,
            status: RunStatus::Skipped {
                reason: reason.to_owned(),
            },
            current_node: None,
            current_edge: None,
            traversed_nodes: Vec::new(),
            traversed_edges: Vec::new(),
            route_summary: format!("Skipped: {reason}"),
            started_at: now,
            finished_at: Some(now),
            duration: Some(Duration::ZERO),
            steps: Vec::new(),
        };
        let delta = self.inner.history.write().await.insert(snapshot.clone());
        let _ = self.inner.history_events.send(delta);
        let _ = self.inner.events.send(WorkflowEvent::RunSkipped {
            run_id: snapshot.run_id.clone(),
            workflow_id: snapshot.workflow_id.clone(),
            reason: reason.to_owned(),
        });
        Ok(snapshot)
    }
}

fn session_error(error: &graph_flow::GraphError) -> WorkflowError {
    WorkflowError::Session {
        message: error.to_string(),
    }
}
