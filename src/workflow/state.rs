use std::{collections::HashSet, sync::Arc, time::SystemTime};

use async_trait::async_trait;
use graph_flow::{InMemorySessionStorage, SessionStorage};
use tokio::sync::{Mutex, RwLock};

use super::{HistoryDelta, HistoryReplay, HistoryRevision, HistoryView, history::HistoryState};
use crate::{
    InMemoryStateConfig, RunId, RunSnapshot, RunStatus, RunTrigger, StateBackendConfig, StepId,
    StepState,
};

pub(super) struct ApplicationState {
    pub(super) graph_sessions: Arc<dyn SessionStorage>,
    pub(super) run_history: Arc<dyn RunHistoryStore>,
    pub(super) schedule_leases: Arc<dyn ScheduleLeaseStore>,
}

impl ApplicationState {
    pub(super) fn build(config: &StateBackendConfig) -> Self {
        match config {
            StateBackendConfig::InMemory(config) => Self::in_memory(config),
        }
    }

    fn in_memory(config: &InMemoryStateConfig) -> Self {
        Self {
            graph_sessions: Arc::new(InMemorySessionStorage::new()),
            run_history: Arc::new(InMemoryRunHistoryStore::new(
                config.history.replay_capacity.get(),
            )),
            schedule_leases: Arc::new(InMemoryScheduleLeaseStore::default()),
        }
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
    pub(super) delta: HistoryDelta,
}

pub(super) struct StepCompleted {
    pub(super) workflow_id: String,
    pub(super) delta: HistoryDelta,
    pub(super) run_completed: bool,
    pub(super) schedule_id: Option<String>,
}

pub(super) struct RunFailed {
    pub(super) workflow_id: String,
    pub(super) delta: HistoryDelta,
    pub(super) schedule_id: Option<String>,
}

#[async_trait]
pub(super) trait RunHistoryStore: Send + Sync {
    async fn insert(&self, snapshot: RunSnapshot) -> HistoryDelta;
    async fn get(&self, run_id: &RunId) -> Option<RunSnapshot>;
    async fn view(&self) -> HistoryView;
    async fn replay(&self, after: HistoryRevision) -> HistoryReplay;
    async fn view_since(&self, after: HistoryRevision) -> (HistoryView, HistoryReplay);
    async fn start_step(&self, run_id: &RunId, node_id: &str) -> Option<StepStarted>;
    async fn complete_step(&self, completion: CompleteStep) -> Option<StepCompleted>;
    async fn fail_run(
        &self,
        run_id: &RunId,
        step_id: Option<StepId>,
        message: String,
    ) -> Option<RunFailed>;
}

struct InMemoryRunHistoryStore {
    state: RwLock<HistoryState>,
}

impl InMemoryRunHistoryStore {
    fn new(replay_capacity: usize) -> Self {
        Self {
            state: RwLock::new(HistoryState::new(replay_capacity)),
        }
    }
}

#[async_trait]
impl RunHistoryStore for InMemoryRunHistoryStore {
    async fn insert(&self, snapshot: RunSnapshot) -> HistoryDelta {
        self.state.write().await.insert(snapshot)
    }

    async fn get(&self, run_id: &RunId) -> Option<RunSnapshot> {
        self.state.read().await.get(run_id)
    }

    async fn view(&self) -> HistoryView {
        self.state.read().await.view()
    }

    async fn replay(&self, after: HistoryRevision) -> HistoryReplay {
        self.state.read().await.replay(after)
    }

    async fn view_since(&self, after: HistoryRevision) -> (HistoryView, HistoryReplay) {
        let state = self.state.read().await;
        (state.view(), state.replay(after))
    }

    async fn start_step(&self, run_id: &RunId, node_id: &str) -> Option<StepStarted> {
        let mut state = self.state.write().await;
        let ((step_id, workflow_id), delta) = state.mutate(run_id, |snapshot| {
            (snapshot.begin_step(node_id), snapshot.workflow_id.clone())
        })?;
        drop(state);
        Some(StepStarted {
            step_id,
            workflow_id,
            delta,
        })
    }

    async fn complete_step(&self, completion: CompleteStep) -> Option<StepCompleted> {
        let mut state = self.state.write().await;
        let ((workflow_id, run_completed, schedule_id), delta) =
            state.mutate(&completion.run_id, |snapshot| {
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
                let schedule_id = completion
                    .terminal
                    .then(|| schedule_id(&snapshot.trigger))
                    .flatten();
                if completion.terminal {
                    let finished_at = SystemTime::now();
                    snapshot.status = RunStatus::Completed;
                    snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
                    snapshot.finished_at = Some(finished_at);
                }
                (
                    snapshot.workflow_id.clone(),
                    completion.terminal,
                    schedule_id,
                )
            })?;
        drop(state);
        Some(StepCompleted {
            workflow_id,
            delta,
            run_completed,
            schedule_id,
        })
    }

    async fn fail_run(
        &self,
        run_id: &RunId,
        step_id: Option<StepId>,
        message: String,
    ) -> Option<RunFailed> {
        let mut state = self.state.write().await;
        let ((workflow_id, schedule_id), delta) = state.mutate(run_id, |snapshot| {
            let finished_at = SystemTime::now();
            snapshot.fail_step(step_id, &message, finished_at);
            snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
            snapshot.finished_at = Some(finished_at);
            snapshot.status = RunStatus::Failed { message };
            (snapshot.workflow_id.clone(), schedule_id(&snapshot.trigger))
        })?;
        drop(state);
        Some(RunFailed {
            workflow_id,
            delta,
            schedule_id,
        })
    }
}

#[async_trait]
pub(super) trait ScheduleLeaseStore: Send + Sync {
    async fn claim(&self, schedule_id: &str) -> bool;
    async fn release(&self, schedule_id: &str);
}

#[derive(Default)]
struct InMemoryScheduleLeaseStore {
    schedule_ids: Mutex<HashSet<String>>,
}

#[async_trait]
impl ScheduleLeaseStore for InMemoryScheduleLeaseStore {
    async fn claim(&self, schedule_id: &str) -> bool {
        self.schedule_ids
            .lock()
            .await
            .insert(schedule_id.to_owned())
    }

    async fn release(&self, schedule_id: &str) {
        self.schedule_ids.lock().await.remove(schedule_id);
    }
}

fn schedule_id(trigger: &RunTrigger) -> Option<String> {
    match trigger {
        RunTrigger::Manual => None,
        RunTrigger::Cron { schedule_id } => Some(schedule_id.clone()),
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
