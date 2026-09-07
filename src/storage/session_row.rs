use garde::Validate;
use graph_flow::Session;
use serde_json::Value;

use crate::WorkflowError;

#[derive(toasty::Model, Validate)]
#[table = "graph_sessions"]
pub(super) struct SessionRow {
    #[key]
    #[garde(custom(non_blank))]
    pub id: String,
    #[garde(range(min = 1))]
    pub version: i64,
    #[garde(custom(non_blank))]
    pub graph_id: String,
    #[garde(custom(non_blank))]
    pub current_task_id: String,
    #[garde(skip)]
    pub status_message: Option<String>,
    #[garde(length(min = 1), custom(json_object))]
    pub context: String,
}

impl SessionRow {
    pub(super) fn from_session(session: &Session) -> Result<Self, WorkflowError> {
        let row = Self {
            id: session.id.clone(),
            version: i64::try_from(session.version)
                .map_err(|_| storage_error("version conversion"))?,
            graph_id: session.graph_id.clone(),
            current_task_id: session.current_task_id.clone(),
            status_message: session.status_message.clone(),
            context: serde_json::to_string(&session.context)
                .map_err(|_| storage_error("context encoding"))?,
        };
        row.validate().map_err(|_| storage_error("validation"))?;
        Ok(row)
    }

    pub(super) fn into_session(self) -> Result<Session, WorkflowError> {
        self.validate().map_err(|_| storage_error("validation"))?;
        let context: Value =
            serde_json::from_str(&self.context).map_err(|_| storage_error("context decoding"))?;
        object(&context, &()).map_err(|_| storage_error("context validation"))?;
        let context =
            serde_json::from_value(context).map_err(|_| storage_error("context restoration"))?;
        let version =
            u64::try_from(self.version).map_err(|_| storage_error("version conversion"))?;

        Ok(Session {
            id: self.id,
            graph_id: self.graph_id,
            current_task_id: self.current_task_id,
            status_message: self.status_message,
            context,
            version,
        })
    }
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn non_blank(value: &str, (): &()) -> garde::Result {
    if value.trim().is_empty() {
        Err(garde::Error::new("must not be blank"))
    } else {
        Ok(())
    }
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn json_object(value: &str, (): &()) -> garde::Result {
    let value: Value =
        serde_json::from_str(value).map_err(|_| garde::Error::new("must be valid JSON"))?;
    object(&value, &())
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn object(value: &Value, (): &()) -> garde::Result {
    if value.is_object() {
        Ok(())
    } else {
        Err(garde::Error::new("must be a JSON object"))
    }
}

fn storage_error(stage: &str) -> WorkflowError {
    WorkflowError::Storage {
        message: format!("persisted session row {stage} failed"),
    }
}

#[cfg(test)]
#[path = "session_row_test.rs"]
mod tests;
