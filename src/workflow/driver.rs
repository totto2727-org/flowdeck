use std::sync::Arc;

use graph_flow::ExecutionStatus;
use tokio::time::timeout;

use super::{Inner, WorkflowRuntime};
use crate::{RunId, RunSnapshot, StepState, WorkflowError, WorkflowExecutionLimits};

#[path = "driver/records.rs"]
mod records;
use records::{
    RunFailure, StepCompletion, active_step_id, record_failure, record_step, record_step_start,
};

pub(super) async fn drive(
    inner: Arc<Inner>,
    run_id: RunId,
    workflow_id: &'static str,
) -> Result<(), WorkflowError> {
    let Some(runtime) = inner.runtimes.get(workflow_id) else {
        return record_failure(
            &inner,
            &run_id,
            RunFailure {
                step_id: None,
                message: "workflow runtime disappeared".to_owned(),
            },
        )
        .await;
    };
    if let Ok(result) = timeout(
        runtime.limits.timeout,
        drive_steps(&inner, &run_id, runtime),
    )
    .await
    {
        result
    } else {
        let step_id = active_step_id(&inner, &run_id).await?;
        record_failure(
            &inner,
            &run_id,
            RunFailure {
                step_id,
                message: format!(
                    "workflow timed out after {} seconds",
                    runtime.limits.timeout.as_secs()
                ),
            },
        )
        .await
    }
}

pub(super) async fn recover_storage_failure(
    inner: &Inner,
    run_id: &RunId,
    error: &WorkflowError,
) -> Result<(), WorkflowError> {
    let step_id = active_step_id(inner, run_id).await?;
    record_failure(
        inner,
        run_id,
        RunFailure {
            step_id,
            message: error.to_string(),
        },
    )
    .await
}

enum DriveControl {
    Continue,
    Stop,
}

struct StepDriver<'a> {
    inner: &'a Inner,
    run_id: &'a RunId,
    runtime: &'a WorkflowRuntime,
    current: &'a str,
}

async fn drive_steps(
    inner: &Inner,
    run_id: &RunId,
    runtime: &WorkflowRuntime,
) -> Result<(), WorkflowError> {
    loop {
        let Some(snapshot) = inner.state.run_history.get(run_id).await? else {
            return Ok(());
        };
        let Some(current) = snapshot.current_node.clone() else {
            return Ok(());
        };
        if let Some(message) = step_limit_failure(&snapshot, &current, runtime.limits) {
            return record_failure(
                inner,
                run_id,
                RunFailure {
                    step_id: None,
                    message,
                },
            )
            .await;
        }
        let step = StepDriver {
            inner,
            run_id,
            runtime,
            current: &current,
        };
        let Some((step_id, result)) = step.execute().await? else {
            return Ok(());
        };
        if matches!(step.complete(step_id, result).await?, DriveControl::Stop) {
            return Ok(());
        }
    }
}

impl StepDriver<'_> {
    async fn execute(
        &self,
    ) -> Result<Option<(crate::StepId, graph_flow::ExecutionResult)>, WorkflowError> {
        let Some(step_id) = record_step_start(self.inner, self.run_id, self.current).await? else {
            return Ok(None);
        };
        match timeout(
            self.runtime.limits.node.timeout,
            self.runtime.runner.run(self.run_id.as_str()),
        )
        .await
        {
            Ok(Ok(result)) => Ok(Some((step_id, result))),
            Ok(Err(error)) => {
                self.fail(Some(step_id), error.to_string()).await?;
                Ok(None)
            }
            Err(_) => {
                self.fail(
                    Some(step_id),
                    format!(
                        "node {} timed out after {} seconds",
                        self.current,
                        self.runtime.limits.node.timeout.as_secs()
                    ),
                )
                .await?;
                Ok(None)
            }
        }
    }

    async fn complete(
        &self,
        step_id: crate::StepId,
        result: graph_flow::ExecutionResult,
    ) -> Result<DriveControl, WorkflowError> {
        match result.status {
            ExecutionStatus::Paused { .. } | ExecutionStatus::Completed => {
                let session = match self.runtime.storage.get(self.run_id.as_str()).await {
                    Ok(Some(session)) => session,
                    Ok(None) => {
                        self.fail(Some(step_id), "session disappeared".to_owned())
                            .await?;
                        return Ok(DriveControl::Stop);
                    }
                    Err(error) => {
                        self.fail(Some(step_id), error.to_string()).await?;
                        return Ok(DriveControl::Stop);
                    }
                };
                let terminal = matches!(result.status, ExecutionStatus::Completed);
                let state = match self
                    .runtime
                    .trace_projector
                    .project(&session.context, self.current)
                {
                    Ok(payload) => StepState { payload },
                    Err(error) => {
                        self.fail(Some(step_id), error.to_string()).await?;
                        return Ok(DriveControl::Stop);
                    }
                };
                record_step(
                    self.inner,
                    self.run_id,
                    StepCompletion {
                        runtime: self.runtime,
                        step_id,
                        current: self.current,
                        next: &session.current_task_id,
                        terminal,
                        output: result.response,
                        state,
                    },
                )
                .await?;
                Ok(if terminal {
                    DriveControl::Stop
                } else {
                    DriveControl::Continue
                })
            }
            ExecutionStatus::WaitingForInput => {
                self.fail(Some(step_id), "unexpected wait-for-input state".to_owned())
                    .await?;
                Ok(DriveControl::Stop)
            }
        }
    }

    async fn fail(
        &self,
        step_id: Option<crate::StepId>,
        message: String,
    ) -> Result<(), WorkflowError> {
        record_failure(self.inner, self.run_id, RunFailure { step_id, message }).await
    }
}

fn step_limit_failure(
    snapshot: &RunSnapshot,
    current: &str,
    limits: WorkflowExecutionLimits,
) -> Option<String> {
    if snapshot.steps.len() >= limits.max_steps {
        return Some(format!(
            "workflow exceeded its total step limit of {}",
            limits.max_steps
        ));
    }
    let node_executions = snapshot
        .steps
        .iter()
        .filter(|step| step.node_id == current)
        .count();
    (node_executions >= limits.node.max_executions).then(|| {
        format!(
            "node {current} exceeded its execution limit of {}",
            limits.node.max_executions
        )
    })
}

#[cfg(test)]
#[path = "driver/tests.rs"]
mod tests;
