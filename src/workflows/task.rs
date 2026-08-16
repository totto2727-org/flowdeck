use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use graph_flow::{Context, GraphError, NextAction, Task, TaskResult};
use serde_json::Value;
use uuid::Uuid;

use super::{INPUT_SUMMARY_KEY, WORKFLOW_INPUT_KEY};

const BRANCH_KEY: &str = "branch_yes";

#[derive(Clone, Copy)]
pub(super) enum TaskBehavior {
    Continue,
    Choose,
    End,
}

#[derive(Clone, Copy)]
pub(super) enum TaskDelay {
    FixedMilliseconds(u64),
    InputMilliseconds(&'static str),
}

pub(super) fn task(
    id: &'static str,
    behavior: TaskBehavior,
    delay: TaskDelay,
) -> Arc<WorkflowTask> {
    Arc::new(WorkflowTask {
        id,
        behavior,
        delay,
    })
}

pub(super) struct WorkflowTask {
    id: &'static str,
    behavior: TaskBehavior,
    delay: TaskDelay,
}

#[async_trait]
impl Task for WorkflowTask {
    fn id(&self) -> &str {
        self.id
    }

    async fn run(&self, context: Context) -> graph_flow::Result<TaskResult> {
        let step_delay_ms = match self.delay {
            TaskDelay::FixedMilliseconds(value) => value,
            TaskDelay::InputMilliseconds(field) => context
                .get::<Value>(WORKFLOW_INPUT_KEY)
                .and_then(|input| input.get(field).and_then(Value::as_u64))
                .ok_or_else(|| {
                    GraphError::ContextError(format!("missing numeric input field: {field}"))
                })?,
        };
        let input_summary = context
            .get::<String>(INPUT_SUMMARY_KEY)
            .ok_or_else(|| GraphError::ContextError("missing input summary".to_owned()))?;
        tokio::time::sleep(Duration::from_millis(step_delay_ms)).await;
        let token = Uuid::new_v4();
        context.set(format!("task_token:{}", self.id), token.to_string())?;
        if matches!(self.behavior, TaskBehavior::Choose) {
            context.set(BRANCH_KEY, token.as_u128().is_multiple_of(2))?;
            context.set("branch_token", token.to_string())?;
        }
        let action = match self.behavior {
            TaskBehavior::Continue | TaskBehavior::Choose => NextAction::Continue,
            TaskBehavior::End => NextAction::End,
        };
        Ok(TaskResult::new(
            Some(format!("{} complete for {input_summary}: {token}", self.id)),
            action,
        ))
    }
}
