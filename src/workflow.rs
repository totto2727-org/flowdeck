use std::{collections::HashMap, fmt, sync::Arc, time::SystemTime};

use graph_flow::{FlowRunner, InMemorySessionStorage, Session, SessionStorage};
use serde_json::Value;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{
    RunId, RunSnapshot, RunStatus, RunTrigger, WorkflowDefinition, WorkflowError,
    workflows::{
        INPUT_SUMMARY_KEY, WORKFLOW_INPUT_KEY, build_graph, definition, parse_input,
        workflow_definitions,
    },
};

#[path = "workflow/driver.rs"]
mod driver;

use driver::drive;

/// Cloneable local boundary for workflow starts, listing, and polling.
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
    runs: RwLock<Vec<RunSnapshot>>,
}

struct WorkflowRuntime {
    definition: &'static WorkflowDefinition,
    runner: FlowRunner,
    storage: Arc<InMemorySessionStorage>,
}

impl WorkflowService {
    /// Build every code-defined graph and its in-memory execution service.
    pub fn new() -> Result<Self, WorkflowError> {
        let mut runtimes = HashMap::new();
        for definition in workflow_definitions() {
            let graph = Arc::new(build_graph(definition.workflow_id)?);
            let storage = Arc::new(InMemorySessionStorage::new());
            let session_storage: Arc<dyn SessionStorage> =
                Arc::<InMemorySessionStorage>::clone(&storage);
            runtimes.insert(
                definition.workflow_id,
                WorkflowRuntime {
                    definition,
                    runner: FlowRunner::new(graph, session_storage),
                    storage,
                },
            );
        }
        Ok(Self {
            inner: Arc::new(Inner {
                runtimes,
                runs: RwLock::new(Vec::new()),
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
        self.inner.runs.write().await.push(snapshot.clone());
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move { drive(inner, run_id, definition.workflow_id).await });
        Ok(snapshot)
    }

    /// List all retained snapshots in start order.
    pub async fn list_runs(&self) -> Vec<RunSnapshot> {
        self.inner.runs.read().await.clone()
    }

    /// Poll one retained snapshot by its opaque run ID.
    pub async fn get_run(&self, run_id: &RunId) -> Option<RunSnapshot> {
        self.inner
            .runs
            .read()
            .await
            .iter()
            .find(|snapshot| snapshot.run_id == *run_id)
            .cloned()
    }
}

fn session_error(error: &graph_flow::GraphError) -> WorkflowError {
    WorkflowError::Session {
        message: error.to_string(),
    }
}
