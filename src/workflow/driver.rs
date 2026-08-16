use std::{sync::Arc, time::SystemTime};

use graph_flow::{ExecutionStatus, SessionStorage};

use super::{Inner, WorkflowRuntime};
use crate::{EdgeSpec, RunId, RunSnapshot, RunStatus, StepState};

struct StepCompletion<'a> {
    current: &'a str,
    next: &'a str,
    terminal: bool,
    output: Option<String>,
    state: StepState,
}

pub(super) async fn drive(inner: Arc<Inner>, run_id: RunId, workflow_id: &'static str) {
    let Some(runtime) = inner.runtimes.get(workflow_id) else {
        record_failure(&inner, &run_id, "workflow runtime disappeared".to_owned()).await;
        return;
    };
    loop {
        let Some(current) = current_node(&inner, &run_id).await else {
            return;
        };
        record_step_start(&inner, &run_id, &current).await;
        let result = match runtime.runner.run(run_id.as_str()).await {
            Ok(result) => result,
            Err(error) => {
                record_failure(&inner, &run_id, error.to_string()).await;
                return;
            }
        };
        match result.status {
            ExecutionStatus::Paused { .. } | ExecutionStatus::Completed => {
                let session = match runtime.storage.get(run_id.as_str()).await {
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
                let Some(state) = StepState::after(&session.context, &current) else {
                    record_failure(&inner, &run_id, "trace state disappeared".to_owned()).await;
                    return;
                };
                record_step(
                    &inner,
                    &run_id,
                    runtime,
                    StepCompletion {
                        current: &current,
                        next: &session.current_task_id,
                        terminal,
                        output: result.response,
                        state,
                    },
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

async fn record_step_start(inner: &Inner, run_id: &RunId, current: &str) {
    let mut runs = inner.runs.write().await;
    if let Some(snapshot) = runs.iter_mut().find(|snapshot| snapshot.run_id == *run_id) {
        snapshot.begin_step(current);
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

async fn record_step(
    inner: &Inner,
    run_id: &RunId,
    runtime: &WorkflowRuntime,
    completion: StepCompletion<'_>,
) {
    let mut runs = inner.runs.write().await;
    let Some(snapshot) = runs.iter_mut().find(|snapshot| snapshot.run_id == *run_id) else {
        return;
    };
    if snapshot
        .traversed_nodes
        .last()
        .is_none_or(|node| node != completion.current)
    {
        snapshot.traversed_nodes.push(completion.current.to_owned());
    }
    let edge = matching_edge(runtime, completion.current, completion.next);
    snapshot.finish_step(
        completion.current,
        edge.map(|edge| edge.id),
        completion.output,
        completion.state,
    );
    if let Some(edge) = edge {
        snapshot.current_edge = Some(edge.id.to_owned());
        snapshot.traversed_edges.push(edge.id.to_owned());
    }
    snapshot.current_node = Some(completion.next.to_owned());
    snapshot.route_summary = route_summary(snapshot);
    if completion.terminal {
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
        snapshot.fail_step(&message, finished_at);
        snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
        snapshot.finished_at = Some(finished_at);
        snapshot.status = RunStatus::Failed { message };
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
