use std::{fmt, sync::Arc, time::SystemTime};

use graph_flow::{ExecutionStatus, FlowRunner, InMemorySessionStorage, Session, SessionStorage};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{
    EDGES, EdgeSpec, NODES, RunId, RunSnapshot, RunStatus, WORKFLOW_ID, WorkflowError, build_graph,
};

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
    runner: FlowRunner,
    storage: Arc<InMemorySessionStorage>,
    runs: RwLock<Vec<RunSnapshot>>,
}

impl WorkflowService {
    /// Build the fixed graph and its in-memory execution service.
    pub fn new() -> Result<Self, WorkflowError> {
        let graph = Arc::new(build_graph()?);
        let storage = Arc::new(InMemorySessionStorage::new());
        let session_storage: Arc<dyn SessionStorage> =
            Arc::<InMemorySessionStorage>::clone(&storage);
        Ok(Self {
            inner: Arc::new(Inner {
                runner: FlowRunner::new(graph, session_storage),
                storage,
                runs: RwLock::new(Vec::new()),
            }),
        })
    }

    /// Validate a workflow ID, retain its first snapshot, and start a driver.
    pub async fn start(&self, workflow_id: &str) -> Result<RunSnapshot, WorkflowError> {
        if workflow_id != WORKFLOW_ID {
            return Err(WorkflowError::UnknownWorkflow {
                workflow_id: workflow_id.to_owned(),
            });
        }
        let run_id = RunId(Uuid::new_v4().to_string());
        let session =
            Session::new_from_task(run_id.0.clone(), NODES[0].id).with_graph_id(WORKFLOW_ID);
        self.inner
            .storage
            .save(session)
            .await
            .map_err(|error| session_error(&error))?;
        let snapshot = RunSnapshot {
            run_id: run_id.clone(),
            workflow_id: WORKFLOW_ID.to_owned(),
            status: RunStatus::Running,
            current_node: Some(NODES[0].id.to_owned()),
            current_edge: None,
            traversed_nodes: Vec::new(),
            traversed_edges: Vec::new(),
            route_summary: NODES[0].id.to_owned(),
            started_at: SystemTime::now(),
            finished_at: None,
            duration: None,
        };
        self.inner.runs.write().await.push(snapshot.clone());
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move { drive(inner, run_id).await });
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

async fn drive(inner: Arc<Inner>, run_id: RunId) {
    loop {
        let Some(current) = current_node(&inner, &run_id).await else {
            return;
        };
        let result = match inner.runner.run(run_id.as_str()).await {
            Ok(result) => result,
            Err(error) => {
                record_failure(&inner, &run_id, error.to_string()).await;
                return;
            }
        };
        match result.status {
            ExecutionStatus::Paused { .. } | ExecutionStatus::Completed => {
                let session = match inner.storage.get(run_id.as_str()).await {
                    Ok(Some(session)) => session,
                    Ok(None) => {
                        record_failure(&inner, &run_id, "session disappeared".to_owned()).await;
                        return;
                    }
                    Err(error) => {
                        record_failure(&inner, &run_id, error.to_string()).await;
                        return;
                    }
                };
                let terminal = matches!(result.status, ExecutionStatus::Completed);
                record_step(
                    &inner,
                    &run_id,
                    &current,
                    &session.current_task_id,
                    terminal,
                )
                .await;
                if terminal {
                    return;
                }
            }
            ExecutionStatus::WaitingForInput => {
                record_failure(
                    &inner,
                    &run_id,
                    "unexpected wait-for-input state".to_owned(),
                )
                .await;
                return;
            }
        }
    }
}

async fn current_node(inner: &Inner, run_id: &RunId) -> Option<String> {
    inner
        .runs
        .read()
        .await
        .iter()
        .find(|snapshot| snapshot.run_id == *run_id)
        .and_then(|snapshot| snapshot.current_node.clone())
}

async fn record_step(inner: &Inner, run_id: &RunId, current: &str, next: &str, terminal: bool) {
    let mut runs = inner.runs.write().await;
    let Some(snapshot) = runs.iter_mut().find(|snapshot| snapshot.run_id == *run_id) else {
        return;
    };
    if snapshot
        .traversed_nodes
        .last()
        .is_none_or(|node| node != current)
    {
        snapshot.traversed_nodes.push(current.to_owned());
    }
    if let Some(edge) = matching_edge(current, next) {
        snapshot.current_edge = Some(edge.id.to_owned());
        snapshot.traversed_edges.push(edge.id.to_owned());
    }
    snapshot.current_node = Some(next.to_owned());
    snapshot.route_summary = route_summary(snapshot);
    if terminal {
        snapshot.status = RunStatus::Completed;
        let finished_at = SystemTime::now();
        snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
        snapshot.finished_at = Some(finished_at);
    }
    drop(runs);
}

async fn record_failure(inner: &Inner, run_id: &RunId, message: String) {
    let mut runs = inner.runs.write().await;
    if let Some(snapshot) = runs.iter_mut().find(|snapshot| snapshot.run_id == *run_id) {
        let finished_at = SystemTime::now();
        snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
        snapshot.finished_at = Some(finished_at);
        snapshot.status = RunStatus::Failed { message };
    }
}

fn matching_edge(current: &str, next: &str) -> Option<&'static EdgeSpec> {
    EDGES
        .iter()
        .find(|edge| edge.from == current && edge.to == next)
}

fn route_summary(snapshot: &RunSnapshot) -> String {
    let mut route = snapshot.traversed_nodes.clone();
    if let Some(current) = &snapshot.current_node
        && route.last() != Some(current)
    {
        route.push(current.clone());
    }
    route.join(" -> ")
}

fn session_error(error: &graph_flow::GraphError) -> WorkflowError {
    WorkflowError::Session {
        message: error.to_string(),
    }
}
