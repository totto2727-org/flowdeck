use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use graph_flow::{Context, GraphError, NextAction, Task, TaskResult};
use uuid::Uuid;

const BRANCH_KEY: &str = "branch_yes";
const INPUT_LABEL_KEY: &str = "run_label";
const STEP_DELAY_KEY: &str = "step_delay_ms";

#[derive(Clone, Copy)]
pub(super) enum TaskBehavior {
    Continue,
    Choose,
    End,
}

pub(super) fn task(id: &'static str, behavior: TaskBehavior) -> Arc<WorkflowTask> {
    Arc::new(WorkflowTask { id, behavior })
}

pub(super) struct WorkflowTask {
    id: &'static str,
    behavior: TaskBehavior,
}

#[async_trait]
impl Task for WorkflowTask {
    fn id(&self) -> &str {
        self.id
    }

    async fn run(&self, context: Context) -> graph_flow::Result<TaskResult> {
        let step_delay_ms = context
            .get::<u64>(STEP_DELAY_KEY)
            .ok_or_else(|| GraphError::ContextError("missing step_delay_ms".to_owned()))?;
        let run_label = context
            .get::<String>(INPUT_LABEL_KEY)
            .ok_or_else(|| GraphError::ContextError("missing run_label".to_owned()))?;
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
            Some(format!("{} complete for {run_label}: {token}", self.id)),
            action,
        ))
    }
}
