use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use garde::Validate;
use graph_flow::{Context, GraphError, NextAction, Task, TaskResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::{INPUT_SUMMARY_KEY, WORKFLOW_INPUT_KEY};

const BRANCH_KEY: &str = "branch_yes";
const BRANCH_TOKEN_KEY: &str = "branch_token";

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
        let delay = match self.delay {
            TaskDelay::FixedMilliseconds(value) => Duration::from_millis(value),
            TaskDelay::InputMilliseconds(field) => input_delay(&context, field)?,
        };
        let input_summary = context
            .get::<String>(INPUT_SUMMARY_KEY)
            .ok_or_else(|| GraphError::ContextError("missing input summary".to_owned()))?;
        tokio::time::sleep(delay).await;
        let token = Uuid::new_v4();
        context.set(format!("task_token:{}", self.id), token.to_string())?;
        if matches!(self.behavior, TaskBehavior::Choose) {
            context.set(BRANCH_KEY, token.as_u128().is_multiple_of(2))?;
            context.set(BRANCH_TOKEN_KEY, token.to_string())?;
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

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct InputDelayDto {
    // Input-driven delay is the demo workflow's existing 100..=2000 ms contract.
    #[garde(range(min = 100, max = 2_000))]
    milliseconds: u64,
}

impl From<InputDelayDto> for Duration {
    fn from(dto: InputDelayDto) -> Self {
        Self::from_millis(dto.milliseconds)
    }
}

fn input_delay(context: &Context, field: &str) -> Result<Duration, GraphError> {
    let input = context
        .get::<Value>(WORKFLOW_INPUT_KEY)
        .ok_or_else(|| GraphError::ContextError("workflow input is missing".to_owned()))?;
    let value = input
        .get(field)
        .ok_or_else(|| GraphError::ContextError(format!("missing input delay field: {field}")))?;
    let dto = serde_json::from_value::<InputDelayDto>(serde_json::json!({ "milliseconds": value }))
        .map_err(|_| {
            GraphError::ContextError(format!("input delay has invalid JSON structure: {field}"))
        })?;
    dto.validate().map_err(|_| {
        GraphError::ContextError(format!(
            "input delay must be between 100 and 2000 milliseconds: {field}"
        ))
    })?;
    Ok(Duration::from(dto))
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct TaskTraceDto {
    // Input is workflow-owned opaque trace data, but its outer structure is an object.
    #[garde(custom(validate_object))]
    input: Value,
    #[garde(inner(custom(validate_uuid)))]
    #[serde(default, deserialize_with = "present_value")]
    task_token: Option<String>,
    #[garde(skip)]
    #[serde(default, deserialize_with = "present_value")]
    branch_selected: Option<bool>,
    #[garde(inner(custom(validate_uuid)))]
    #[serde(default, deserialize_with = "present_value")]
    branch_token: Option<String>,
}

struct TaskTrace {
    input: Value,
    task_token: Option<Uuid>,
    branch: Option<BranchTrace>,
}

struct BranchTrace {
    selected: bool,
    token: Uuid,
}

impl TryFrom<TaskTraceDto> for TaskTrace {
    type Error = crate::WorkflowError;

    fn try_from(dto: TaskTraceDto) -> Result<Self, Self::Error> {
        let parse_token = |token: String| {
            Uuid::parse_str(&token).map_err(|_| trace_error("trace token must be a UUID"))
        };
        let task_token = dto.task_token.map(parse_token).transpose()?;
        let branch = match (dto.branch_selected, dto.branch_token) {
            (Some(selected), Some(token)) => Some(BranchTrace {
                selected,
                token: parse_token(token)?,
            }),
            (None, None) => None,
            _ => {
                return Err(trace_error(
                    "branch selection and token must be present together",
                ));
            }
        };
        Ok(Self {
            input: dto.input,
            task_token,
            branch,
        })
    }
}

#[derive(Serialize)]
struct TaskTraceOutputDto<'a> {
    input: &'a Value,
    task_token: Option<String>,
    branch_selected: Option<bool>,
    branch_token: Option<String>,
}

pub(super) fn project_trace(
    context: &Context,
    node_id: &str,
) -> Result<Value, crate::WorkflowError> {
    // Context::get<T> suppresses structural decoding failures as None. Read raw values
    // only here, then decode the complete projection so corruption is not treated as absence.
    let input = context
        .get::<Value>(WORKFLOW_INPUT_KEY)
        .ok_or_else(|| trace_error("workflow input is missing"))?;
    let mut fields = serde_json::Map::from_iter([("input".to_owned(), input)]);
    for (field, key) in [
        ("task_token", format!("task_token:{node_id}")),
        ("branch_selected", BRANCH_KEY.to_owned()),
        ("branch_token", BRANCH_TOKEN_KEY.to_owned()),
    ] {
        if let Some(value) = context.get::<Value>(&key) {
            fields.insert(field.to_owned(), value);
        }
    }
    let dto = serde_json::from_value::<TaskTraceDto>(Value::Object(fields))
        .map_err(|_| trace_error("task trace has invalid JSON structure"))?;
    dto.validate()
        .map_err(|error| trace_error(&format!("task trace validation failed: {error}")))?;
    let trace = TaskTrace::try_from(dto)?;
    serde_json::to_value(TaskTraceOutputDto {
        input: &trace.input,
        task_token: trace.task_token.map(|token| token.to_string()),
        branch_selected: trace.branch.as_ref().map(|branch| branch.selected),
        branch_token: trace.branch.as_ref().map(|branch| branch.token.to_string()),
    })
    .map_err(|_| trace_error("task trace serialization failed"))
}

// Missing optional keys default to None. A present key must contain its declared type,
// including rejecting explicit null instead of hiding corrupt stored state as absence.
fn present_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde validator signature."
)]
fn validate_uuid(value: &str, _: &()) -> garde::Result {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| garde::Error::new("must be a UUID"))
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde validator signature."
)]
fn validate_object(value: &Value, _: &()) -> garde::Result {
    if !value.is_object() {
        return Err(garde::Error::new("must be an object"));
    }
    Ok(())
}

fn trace_error(message: &str) -> crate::WorkflowError {
    crate::WorkflowError::Trace {
        message: message.to_owned(),
    }
}

#[cfg(test)]
#[path = "task_test.rs"]
mod tests;
