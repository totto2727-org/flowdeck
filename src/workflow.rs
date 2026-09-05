use std::{collections::HashMap, fmt, sync::Arc, time::SystemTime};

use graph_flow::{FlowRunner, Session, SessionStorage};
use serde_json::Value;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    RunId, RunSnapshot, RunStatus, RunTrigger, SchedulerConfig, WorkflowDefinition, WorkflowError,
    WorkflowExecutionLimits,
    workflows::{
        INPUT_SUMMARY_KEY, TraceProjector, WORKFLOW_INPUT_KEY, WORKFLOW_RUN_ID_KEY,
        WorkflowInputContract,
    },
};

#[path = "workflow/bootstrap.rs"]
mod bootstrap;
#[path = "workflow/driver.rs"]
mod driver;
#[path = "workflow/events.rs"]
mod events;
#[path = "workflow/history.rs"]
mod history;
#[path = "workflow/run_group.rs"]
mod run_group;
#[path = "workflow/schedule_attempt.rs"]
mod schedule_attempt;
#[path = "workflow/state.rs"]
mod state;
#[path = "workflow/tasks.rs"]
mod tasks;

use driver::drive;
pub use events::WorkflowEvent;
pub use history::HistoryView;
use run_group::ActiveRunGroup;
use state::ApplicationState;
use tasks::WorkflowTasks;

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
    state: ApplicationState,
    scheduler: SchedulerConfig,
    run_group: ActiveRunGroup,
    events: broadcast::Sender<WorkflowEvent>,
    tasks: WorkflowTasks,
}

struct WorkflowRuntime {
    definition: &'static WorkflowDefinition,
    input: Arc<dyn WorkflowInputContract>,
    trace_projector: Arc<dyn TraceProjector>,
    limits: WorkflowExecutionLimits,
    runner: FlowRunner,
    storage: Arc<dyn SessionStorage>,
}

impl WorkflowService {
    /// Validate a workflow ID, retain its first snapshot, and start its driver.
    #[allow(
        clippy::significant_drop_tightening,
        reason = "The run-group guard intentionally spans session setup and is then moved into the driver task."
    )]
    pub async fn start(
        &self,
        workflow_id: &str,
        raw_input: Value,
        trigger: RunTrigger,
    ) -> Result<RunSnapshot, WorkflowError> {
        let runtime =
            self.inner
                .runtimes
                .get(workflow_id)
                .ok_or_else(|| WorkflowError::UnknownWorkflow {
                    workflow_id: workflow_id.to_owned(),
                })?;
        let definition = runtime.definition;
        let input = runtime.input.parse(raw_input)?;
        let run_guard = self
            .inner
            .run_group
            .try_join()
            .map_err(|error| WorkflowError::ActiveRunLimit { limit: error.limit })?;
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
            .set(WORKFLOW_RUN_ID_KEY, run_id.as_str())
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
        self.inner
            .state
            .run_history
            .insert_active(snapshot.clone(), session)
            .await?;
        let _ = self.inner.events.send(WorkflowEvent::RunStarted {
            run_id: run_id.clone(),
            workflow_id: definition.workflow_id.to_owned(),
        });
        let inner = Arc::clone(&self.inner);
        self.inner.tasks.spawn(async move {
            let _run_guard = run_guard;
            if let Err(error) =
                drive(Arc::clone(&inner), run_id.clone(), definition.workflow_id).await
            {
                tracing::error!(%run_id, %error, "workflow driver persistence failed");
                if let Err(recovery_error) =
                    driver::recover_storage_failure(&inner, &run_id, &error).await
                {
                    tracing::error!(%run_id, original_error = %error, %recovery_error,
                        "workflow failure could not be persisted; no terminal event emitted");
                }
            }
        });
        Ok(snapshot)
    }

    /// Subscribe to future workflow lifecycle notifications.
    pub fn subscribe(&self) -> broadcast::Receiver<WorkflowEvent> {
        self.inner.events.subscribe()
    }

    /// Read every retained run atomically.
    pub async fn history_view(&self) -> Result<HistoryView, WorkflowError> {
        self.inner.state.run_history.view().await
    }

    /// List all retained snapshots in start order.
    pub async fn list_runs(&self) -> Result<Vec<RunSnapshot>, WorkflowError> {
        Ok(self.inner.state.run_history.view().await?.runs)
    }

    /// Poll one retained snapshot by its opaque run ID.
    pub async fn get_run(&self, run_id: &RunId) -> Result<Option<RunSnapshot>, WorkflowError> {
        self.inner.state.run_history.get(run_id).await
    }

    pub(crate) async fn claim_schedule(&self, schedule_id: &str) -> Result<bool, WorkflowError> {
        self.inner.state.schedule_leases.claim(schedule_id).await
    }

    pub(crate) async fn release_schedule(&self, schedule_id: &str) -> Result<(), WorkflowError> {
        self.inner.state.schedule_leases.release(schedule_id).await
    }

    pub(crate) fn contains_workflow(&self, workflow_id: &str) -> bool {
        self.inner.runtimes.contains_key(workflow_id)
    }

    pub(crate) fn scheduled_input(
        &self,
        workflow_id: &str,
        schedule_id: &str,
    ) -> Result<Value, WorkflowError> {
        self.inner
            .runtimes
            .get(workflow_id)
            .ok_or_else(|| WorkflowError::UnknownWorkflow {
                workflow_id: workflow_id.to_owned(),
            })?
            .input
            .scheduled(schedule_id)
    }

    pub(crate) fn validate_input(
        &self,
        workflow_id: &str,
        input: Value,
    ) -> Result<(), WorkflowError> {
        self.inner
            .runtimes
            .get(workflow_id)
            .ok_or_else(|| WorkflowError::UnknownWorkflow {
                workflow_id: workflow_id.to_owned(),
            })?
            .input
            .parse(input)
            .map(|_| ())
    }

    pub(crate) fn scheduler_config(&self) -> &SchedulerConfig {
        &self.inner.scheduler
    }
}

fn session_error(error: &graph_flow::GraphError) -> WorkflowError {
    WorkflowError::Session {
        message: error.to_string(),
    }
}
