use garde::Validate;

use crate::RunStatus;

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
