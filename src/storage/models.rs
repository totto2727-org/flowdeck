use garde::Validate;
use graph_flow::Session;

use super::{error, run_dto, status_name};
use crate::{RunSnapshot, WorkflowError};

#[derive(Debug, toasty::Model, Validate)]
#[table = "runs"]
pub(super) struct RunRow {
    #[key]
    #[garde(custom(non_blank))]
    pub id: String,
    #[garde(range(min = 1))]
    pub start_order: i64,
    #[garde(range(min = 1))]
    pub terminal_order: Option<i64>,
    #[garde(custom(valid_status))]
    pub status: String,
    #[garde(length(min = 1))]
    pub snapshot: String,
}

impl RunRow {
    pub(super) fn into_snapshot(self) -> Result<RunSnapshot, WorkflowError> {
        self.validate().map_err(error)?;
        let snapshot = run_dto::decode(&self.snapshot)?;
        if snapshot.run_id.as_str() != self.id
            || status_name(&snapshot.status) != self.status
            || (self.status == "running") != self.terminal_order.is_none()
        {
            return Err(error("run row and snapshot metadata disagree"));
        }
        Ok(snapshot)
    }
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn valid_status(value: &str, (): &()) -> garde::Result {
    if matches!(value, "running" | "completed" | "failed" | "skipped") {
        Ok(())
    } else {
        Err(garde::Error::new("unknown run status"))
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

#[derive(Debug, toasty::Model, Validate)]
#[table = "store_clocks"]
pub(super) struct ClockRow {
    #[key]
    #[garde(custom(clock_id))]
    pub id: String,
    #[garde(range(min = 0))]
    pub value: i64,
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

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn clock_id(value: &str, (): &()) -> garde::Result {
    if matches!(value, "start" | "terminal") {
        Ok(())
    } else {
        Err(garde::Error::new("unknown storage clock"))
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
