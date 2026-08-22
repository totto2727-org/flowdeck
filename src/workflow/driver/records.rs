use std::time::SystemTime;

use super::super::{Inner, WorkflowRuntime};
use crate::{
    EdgeSpec, RunId, RunSnapshot, RunStatus, RunTrigger, StepId, StepState, WorkflowEvent,
};

pub(super) struct StepCompletion<'a> {
    pub(super) runtime: &'a WorkflowRuntime,
    pub(super) step_id: StepId,
    pub(super) current: &'a str,
    pub(super) next: &'a str,
    pub(super) terminal: bool,
    pub(super) output: Option<String>,
    pub(super) state: StepState,
}

pub(super) struct RunFailure {
    pub(super) step_id: Option<StepId>,
    pub(super) message: String,
}

pub(super) async fn active_step_id(inner: &Inner, run_id: &RunId) -> Option<StepId> {
    inner.history.read().await.get(run_id).and_then(|snapshot| {
        snapshot
            .steps
            .iter()
            .rev()
            .find(|step| step.status == crate::StepTraceStatus::Running)
            .map(|step| step.step_id)
    })
}

pub(super) async fn record_step_start(
    inner: &Inner,
    run_id: &RunId,
    current: &str,
) -> Option<StepId> {
    let change = {
        let mut history = inner.history.write().await;
        history.mutate(run_id, |snapshot| {
            let step_id = snapshot.begin_step(current);
            (
                step_id,
                WorkflowEvent::NodeStarted {
                    run_id: run_id.clone(),
                    workflow_id: snapshot.workflow_id.clone(),
                    node_id: current.to_owned(),
                    step_id,
                },
            )
        })
    };
    let ((step_id, event), delta) = change?;
    let _ = inner.history_events.send(delta);
    let _ = inner.events.send(event);
    Some(step_id)
}

pub(super) async fn record_step(inner: &Inner, run_id: &RunId, completion: StepCompletion<'_>) {
    let change = {
        let mut history = inner.history.write().await;
        history.mutate(run_id, |snapshot| {
            snapshot.traversed_nodes.push(completion.current.to_owned());
            let edge_id = matching_edge(completion.runtime, completion.current, completion.next)
                .map(|edge| edge.id.to_owned());
            snapshot.finish_step(
                completion.step_id,
                edge_id.as_deref(),
                completion.output,
                completion.state,
            );
            if let Some(edge_id) = &edge_id {
                snapshot.current_edge = Some(edge_id.clone());
                snapshot.traversed_edges.push(edge_id.clone());
            }
            snapshot.current_node = Some(completion.next.to_owned());
            snapshot.route_summary = route_summary(snapshot);
            let node_completed = WorkflowEvent::NodeCompleted {
                run_id: run_id.clone(),
                workflow_id: snapshot.workflow_id.clone(),
                node_id: completion.current.to_owned(),
                step_id: completion.step_id,
                edge_id,
            };
            let (run_completed, schedule_id) = if completion.terminal {
                snapshot.status = RunStatus::Completed;
                let finished_at = SystemTime::now();
                snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
                snapshot.finished_at = Some(finished_at);
                (
                    Some(WorkflowEvent::RunCompleted {
                        run_id: run_id.clone(),
                        workflow_id: snapshot.workflow_id.clone(),
                    }),
                    schedule_id(&snapshot.trigger),
                )
            } else {
                (None, None)
            };
            (node_completed, run_completed, schedule_id)
        })
    };
    let Some(((node_completed, run_completed, schedule_id), delta)) = change else {
        return;
    };
    let _ = inner.history_events.send(delta);
    let _ = inner.events.send(node_completed);
    if let Some(run_completed) = run_completed {
        let _ = inner.events.send(run_completed);
    }
    release_schedule(inner, schedule_id).await;
}

pub(super) async fn record_failure(inner: &Inner, run_id: &RunId, failure: RunFailure) {
    let change = {
        let mut history = inner.history.write().await;
        history.mutate(run_id, |snapshot| {
            let finished_at = SystemTime::now();
            snapshot.fail_step(failure.step_id, &failure.message, finished_at);
            snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
            snapshot.finished_at = Some(finished_at);
            snapshot.status = RunStatus::Failed {
                message: failure.message.clone(),
            };
            let event = WorkflowEvent::RunFailed {
                run_id: run_id.clone(),
                workflow_id: snapshot.workflow_id.clone(),
                message: failure.message,
            };
            (event, schedule_id(&snapshot.trigger))
        })
    };
    let Some(((event, schedule_id), delta)) = change else {
        return;
    };
    let _ = inner.history_events.send(delta);
    let _ = inner.events.send(event);
    release_schedule(inner, schedule_id).await;
}

async fn release_schedule(inner: &Inner, schedule_id: Option<String>) {
    if let Some(schedule_id) = schedule_id {
        inner.running_schedules.lock().await.remove(&schedule_id);
    }
}

fn schedule_id(trigger: &RunTrigger) -> Option<String> {
    match trigger {
        RunTrigger::Manual => None,
        RunTrigger::Cron { schedule_id } => Some(schedule_id.clone()),
    }
}

fn matching_edge(
    runtime: &WorkflowRuntime,
    current: &str,
    next: &str,
) -> Option<&'static EdgeSpec> {
    runtime
        .definition
        .edges
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
