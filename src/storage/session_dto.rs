use garde::Validate;
use graph_flow::Session;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::WorkflowError;

/// Storage format version and graph-flow's optimistic-lock version are independent.
#[derive(Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct SessionDto {
    #[garde(range(min = 1, max = 1))]
    schema_version: u8,
    #[garde(custom(non_blank))]
    id: String,
    #[garde(custom(non_blank))]
    graph_id: String,
    #[garde(custom(non_blank))]
    current_task_id: String,
    #[garde(skip)]
    status_message: Option<String>,
    // Graph-flow owns the context envelope and workflow-owned values inside it.
    #[garde(custom(object))]
    context: Value,
    #[garde(custom(sqlite_version))]
    version: u64,
}

pub(crate) fn encode(session: &Session) -> Result<String, WorkflowError> {
    let dto = SessionDto {
        schema_version: 1,
        id: session.id.clone(),
        graph_id: session.graph_id.clone(),
        current_task_id: session.current_task_id.clone(),
        status_message: session.status_message.clone(),
        context: serde_json::to_value(&session.context)
            .map_err(|_| storage_error("context encoding failed"))?,
        version: session.version,
    };
    dto.validate()
        .map_err(|error| storage_error(format!("validation failed: {error}")))?;
    serde_json::to_string(&dto).map_err(|_| storage_error("encoding failed"))
}

pub(crate) fn decode(json: &str) -> Result<Session, WorkflowError> {
    let dto: SessionDto = serde_json::from_str(json)
        .map_err(|_| storage_error("invalid JSON or incompatible wire fields"))?;
    dto.validate()
        .map_err(|error| storage_error(format!("validation failed: {error}")))?;
    let context = serde_json::from_value(dto.context)
        .map_err(|_| storage_error("invalid graph-flow context envelope"))?;
    Ok(Session {
        id: dto.id,
        graph_id: dto.graph_id,
        current_task_id: dto.current_task_id,
        status_message: dto.status_message,
        context,
        version: dto.version,
    })
}

fn non_blank(value: &str, (): &()) -> garde::Result {
    if value.trim().is_empty() {
        Err(garde::Error::new("must not be blank"))
    } else {
        Ok(())
    }
}

fn object(value: &Value, (): &()) -> garde::Result {
    if value.is_object() {
        Ok(())
    } else {
        Err(garde::Error::new("must be a JSON object"))
    }
}

fn sqlite_version(value: &u64, (): &()) -> garde::Result {
    if i64::try_from(*value).is_ok() {
        Ok(())
    } else {
        Err(garde::Error::new("must fit a signed SQLite integer"))
    }
}

fn storage_error(message: impl std::fmt::Display) -> WorkflowError {
    WorkflowError::Storage {
        message: format!("persisted session {message}"),
    }
}

#[cfg(test)]
#[path = "session_dto_test.rs"]
mod tests;
