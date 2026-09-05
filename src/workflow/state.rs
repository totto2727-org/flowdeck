use std::{sync::Arc, time::SystemTime};

use async_trait::async_trait;
use graph_flow::{Session, SessionStorage};

use super::HistoryView;
use crate::{
    RunId, RunSnapshot, RunStatus, StateBackendConfig, StepId, StepState, WorkflowError,
    storage::SqliteStore,
};

pub(super) struct ApplicationState {
    pub(super) graph_sessions: Arc<dyn SessionStorage>,
    pub(super) run_history: Arc<dyn RunHistoryStore>,
    pub(super) schedule_leases: Arc<dyn ScheduleLeaseStore>,
}

impl ApplicationState {
    pub(super) async fn build(config: &StateBackendConfig) -> Result<Self, WorkflowError> {
        let StateBackendConfig::Sqlite(config) = config;
        let store = Arc::new(SqliteStore::open(config).await?);
        Ok(Self {
            graph_sessions: Arc::<SqliteStore>::clone(&store),
            run_history: Arc::<SqliteStore>::clone(&store),
            schedule_leases: store,
        })
    }
}

pub(super) struct CompleteStep {
    pub(super) run_id: RunId,
    pub(super) step_id: StepId,
    pub(super) current: String,
    pub(super) next: String,
    pub(super) edge_id: Option<String>,
    pub(super) terminal: bool,
    pub(super) output: Option<String>,
    pub(super) state: StepState,
}

pub(super) struct StepStarted {
    pub(super) step_id: StepId,
    pub(super) workflow_id: String,
}

pub(super) struct StepCompleted {
    pub(super) workflow_id: String,
    pub(super) run_completed: bool,
}

pub(super) struct RunFailed {
    pub(super) workflow_id: String,
}

#[async_trait]
pub(super) trait RunHistoryStore: Send + Sync {
    async fn insert_active(
        &self,
        snapshot: RunSnapshot,
        session: Session,
    ) -> Result<(), WorkflowError>;
    async fn insert_terminal(&self, snapshot: RunSnapshot) -> Result<(), WorkflowError>;
    async fn get(&self, run_id: &RunId) -> Result<Option<RunSnapshot>, WorkflowError>;
    async fn view(&self) -> Result<HistoryView, WorkflowError>;
    async fn start_step(
        &self,
        run_id: &RunId,
        node_id: &str,
    ) -> Result<Option<StepStarted>, WorkflowError>;
    async fn complete_step(
        &self,
        completion: CompleteStep,
    ) -> Result<Option<StepCompleted>, WorkflowError>;
    async fn fail_run(
        &self,
        run_id: &RunId,
        step_id: Option<StepId>,
        message: String,
    ) -> Result<Option<RunFailed>, WorkflowError>;
}

#[async_trait]
impl RunHistoryStore for SqliteStore {
    async fn insert_active(
        &self,
        snapshot: RunSnapshot,
        session: Session,
    ) -> Result<(), WorkflowError> {
        self.insert_run(snapshot, Some(session)).await
    }

    async fn insert_terminal(&self, snapshot: RunSnapshot) -> Result<(), WorkflowError> {
        self.insert_run(snapshot, None).await
    }

    async fn get(&self, run_id: &RunId) -> Result<Option<RunSnapshot>, WorkflowError> {
        self.get_run(run_id).await
    }

    async fn view(&self) -> Result<HistoryView, WorkflowError> {
        self.history().await
    }

    async fn start_step(
        &self,
        run_id: &RunId,
        node_id: &str,
    ) -> Result<Option<StepStarted>, WorkflowError> {
        self.mutate_run(run_id, |snapshot| StepStarted {
            step_id: snapshot.begin_step(node_id),
            workflow_id: snapshot.workflow_id.clone(),
        })
        .await
    }

    async fn complete_step(
        &self,
        completion: CompleteStep,
    ) -> Result<Option<StepCompleted>, WorkflowError> {
        self.mutate_run(&completion.run_id, |snapshot| {
            snapshot.traversed_nodes.push(completion.current);
            snapshot.finish_step(
                completion.step_id,
                completion.edge_id.as_deref(),
                completion.output,
                completion.state,
            );
            if let Some(edge_id) = completion.edge_id {
                snapshot.current_edge = Some(edge_id.clone());
                snapshot.traversed_edges.push(edge_id);
            }
            snapshot.current_node = Some(completion.next);
            snapshot.route_summary = route_summary(snapshot);
            if completion.terminal {
                let finished_at = SystemTime::now();
                snapshot.status = RunStatus::Completed;
                snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
                snapshot.finished_at = Some(finished_at);
            }
            StepCompleted {
                workflow_id: snapshot.workflow_id.clone(),
                run_completed: completion.terminal,
            }
        })
        .await
    }

    async fn fail_run(
        &self,
        run_id: &RunId,
        step_id: Option<StepId>,
        message: String,
    ) -> Result<Option<RunFailed>, WorkflowError> {
        self.mutate_run(run_id, |snapshot| {
            let finished_at = SystemTime::now();
            snapshot.fail_step(step_id, &message, finished_at);
            snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
            snapshot.finished_at = Some(finished_at);
            snapshot.status = RunStatus::Failed { message };
            RunFailed {
                workflow_id: snapshot.workflow_id.clone(),
            }
        })
        .await
    }
}

#[async_trait]
pub(super) trait ScheduleLeaseStore: Send + Sync {
    async fn claim(&self, schedule_id: &str) -> Result<bool, WorkflowError>;
    async fn release(&self, schedule_id: &str) -> Result<(), WorkflowError>;
}

#[async_trait]
impl ScheduleLeaseStore for SqliteStore {
    async fn claim(&self, schedule_id: &str) -> Result<bool, WorkflowError> {
        self.claim_lease(schedule_id).await
    }
    async fn release(&self, schedule_id: &str) -> Result<(), WorkflowError> {
        self.release_lease(schedule_id).await
    }
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
