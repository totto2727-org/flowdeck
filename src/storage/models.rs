use garde::Validate;
use graph_flow::Session;

use super::{epoch_millis, error, run_dto};
use crate::{RunSnapshot, RunStatus, WorkflowError};

#[derive(Debug, toasty::Model, Validate)]
#[table = "runs"]
pub(super) struct RunRow {
    #[key]
    #[garde(custom(non_blank))]
    pub id: String,
    #[garde(range(min = 0))]
    pub started_at: i64,
    #[garde(range(min = 0))]
    pub finished_at: Option<i64>,
    #[garde(skip)]
    pub status: RunStatusRow,
    #[garde(length(min = 1))]
    pub snapshot: String,
}

impl RunRow {
    pub(super) fn into_snapshot(self) -> Result<RunSnapshot, WorkflowError> {
        self.validate().map_err(error)?;
        let snapshot = run_dto::decode(&self.snapshot)?;
        if snapshot.run_id.as_str() != self.id
            || RunStatusRow::from(&snapshot.status) != self.status
            || epoch_millis(snapshot.started_at)? != self.started_at
            || snapshot.finished_at.map(epoch_millis).transpose()? != self.finished_at
            || (self.status == RunStatusRow::Running) != self.finished_at.is_none()
        {
            return Err(error("run row and snapshot metadata disagree"));
        }
        Ok(snapshot)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, toasty::Embed)]
pub(super) enum RunStatusRow {
    Running,
    Completed,
    Failed,
    Skipped,
}

impl From<&RunStatus> for RunStatusRow {
    fn from(status: &RunStatus) -> Self {
        match status {
            RunStatus::Running => Self::Running,
            RunStatus::Completed => Self::Completed,
            RunStatus::Failed { .. } => Self::Failed,
            RunStatus::Skipped { .. } => Self::Skipped,
        }
    }
}

impl RunStatusRow {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

#[derive(Debug, toasty::Model, Validate)]
#[table = "graph_sessions"]
pub(super) struct SessionRow {
    #[key]
    #[garde(custom(non_blank))]
    pub id: String,
    #[garde(range(min = 1))]
    pub version: i64,
    #[garde(length(min = 1))]
    pub payload: String,
}

impl SessionRow {
    pub(super) fn into_session(self) -> Result<Session, WorkflowError> {
        self.validate().map_err(error)?;
        let session: Session = super::session_dto::decode(&self.payload)?;
        if session.id != self.id
            || i64::try_from(session.version).map_err(error)? != self.version
            || session.graph_id.is_empty()
            || session.current_task_id.is_empty()
        {
            return Err(error("session row and payload metadata disagree"));
        }
        Ok(session)
    }
}

#[derive(Debug, toasty::Model, Validate)]
#[table = "schedule_leases"]
pub(super) struct LeaseRow {
    #[key]
    #[garde(custom(non_blank))]
    pub id: String,
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn non_blank(value: &str, (): &()) -> garde::Result {
    if value.trim().is_empty() {
        Err(garde::Error::new("identifier must not be blank"))
    } else {
        Ok(())
    }
}

#[derive(Debug, toasty::Model, Validate)]
#[table = "__toasty_migrations"]
pub(super) struct MigrationRow {
    #[key]
    #[garde(range(min = 1))]
    pub id: i64,
    #[garde(custom(non_blank))]
    pub name: String,
    #[garde(custom(non_blank))]
    pub applied_at: String,
}
