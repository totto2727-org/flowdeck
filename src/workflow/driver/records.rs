use super::super::state::CompleteStep;
use super::super::{Inner, WorkflowRuntime};
use crate::{EdgeSpec, RunId, StepId, StepState, WorkflowEvent};

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
    inner
        .state
        .run_history
        .get(run_id)
        .await
        .and_then(|snapshot| {
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
    let started = inner.state.run_history.start_step(run_id, current).await?;
    let event = WorkflowEvent::NodeStarted {
        run_id: run_id.clone(),
        workflow_id: started.workflow_id,
        node_id: current.to_owned(),
        step_id: started.step_id,
    };
    let _ = inner.events.send(event);
    Some(started.step_id)
}

pub(super) async fn record_step(inner: &Inner, run_id: &RunId, completion: StepCompletion<'_>) {
    let edge_id = matching_edge(completion.runtime, completion.current, completion.next)
        .map(|edge| edge.id.to_owned());
    let Some(completed) = inner
        .state
        .run_history
        .complete_step(CompleteStep {
            run_id: run_id.clone(),
            step_id: completion.step_id,
            current: completion.current.to_owned(),
            next: completion.next.to_owned(),
            edge_id: edge_id.clone(),
            terminal: completion.terminal,
            output: completion.output,
            state: completion.state,
        })
        .await
    else {
        return;
    };
    let node_completed = WorkflowEvent::NodeCompleted {
        run_id: run_id.clone(),
        workflow_id: completed.workflow_id.clone(),
        node_id: completion.current.to_owned(),
        step_id: completion.step_id,
        edge_id,
    };
    let _ = inner.events.send(node_completed);
    if completed.run_completed {
        let _ = inner.events.send(WorkflowEvent::RunCompleted {
            run_id: run_id.clone(),
            workflow_id: completed.workflow_id,
        });
    }
    release_schedule(inner, completed.schedule_id).await;
}

pub(super) async fn record_failure(inner: &Inner, run_id: &RunId, failure: RunFailure) {
    let message = failure.message;
    let Some(failed) = inner
        .state
        .run_history
        .fail_run(run_id, failure.step_id, message.clone())
        .await
    else {
        return;
    };
    let _ = inner.events.send(WorkflowEvent::RunFailed {
        run_id: run_id.clone(),
        workflow_id: failed.workflow_id,
        message,
    });
    release_schedule(inner, failed.schedule_id).await;
}

async fn release_schedule(inner: &Inner, schedule_id: Option<String>) {
    if let Some(schedule_id) = schedule_id {
        inner.state.schedule_leases.release(&schedule_id).await;
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
