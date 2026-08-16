use std::{sync::Arc, time::SystemTime};

use graph_flow::{ExecutionStatus, SessionStorage};

use super::{Inner, WorkflowRuntime};
use crate::{EdgeSpec, RunId, RunSnapshot, RunStatus, StepState, WorkflowEvent};

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
    let event = {
        let mut runs = inner.runs.write().await;
        let Some(snapshot) = runs.iter_mut().find(|snapshot| snapshot.run_id == *run_id) else {
            return;
        };
        snapshot.begin_step(current);
        let event = WorkflowEvent::NodeStarted {
            run_id: run_id.clone(),
            workflow_id: snapshot.workflow_id.clone(),
            node_id: current.to_owned(),
        };
        drop(runs);
        event
    };
    let _ = inner.events.send(event);
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
    let (node_completed, run_completed) = {
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
        let edge_id = matching_edge(runtime, completion.current, completion.next)
            .map(|edge| edge.id.to_owned());
        snapshot.finish_step(
            completion.current,
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
            edge_id,
        };
        let run_completed = if completion.terminal {
            snapshot.status = RunStatus::Completed;
            let finished_at = SystemTime::now();
            snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
            snapshot.finished_at = Some(finished_at);
            Some(WorkflowEvent::RunCompleted {
                run_id: run_id.clone(),
                workflow_id: snapshot.workflow_id.clone(),
            })
        } else {
            None
        };
        drop(runs);
        (node_completed, run_completed)
    };
    let _ = inner.events.send(node_completed);
    if let Some(run_completed) = run_completed {
        let _ = inner.events.send(run_completed);
    }
}

async fn record_failure(inner: &Inner, run_id: &RunId, message: String) {
    let event = {
        let mut runs = inner.runs.write().await;
        let Some(snapshot) = runs.iter_mut().find(|snapshot| snapshot.run_id == *run_id) else {
            return;
        };
        let finished_at = SystemTime::now();
        snapshot.fail_step(&message, finished_at);
        snapshot.duration = finished_at.duration_since(snapshot.started_at).ok();
        snapshot.finished_at = Some(finished_at);
        snapshot.status = RunStatus::Failed {
            message: message.clone(),
        };
        let event = WorkflowEvent::RunFailed {
            run_id: run_id.clone(),
            workflow_id: snapshot.workflow_id.clone(),
            message,
        };
        drop(runs);
        event
    };
    let _ = inner.events.send(event);
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
