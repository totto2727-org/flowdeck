use garde::Validate;

use super::models::RunStatusRow;

#[derive(Debug, Clone, Copy, PartialEq, Eq, toasty::Embed)]
pub(super) enum RunTriggerRow {
    Manual,
    Cron,
}

#[derive(Debug, toasty::Model, Validate)]
#[table = "runs"]
pub(super) struct RunRow {
    #[key]
    #[garde(custom(non_blank))]
    pub id: String,
    #[garde(custom(non_blank))]
    pub workflow_id: String,
    #[garde(length(min = 1))]
    pub input: String,
    #[garde(skip)]
    pub input_summary: String,
    #[garde(skip)]
    pub trigger: RunTriggerRow,
    #[garde(skip)]
    pub schedule_id: Option<String>,
    #[garde(skip)]
    pub status: RunStatusRow,
    #[garde(skip)]
    pub status_message: Option<String>,
    #[garde(skip)]
    pub current_node: Option<String>,
    #[garde(skip)]
    pub route_summary: String,
    #[garde(range(min = 0))]
    pub started_at: i64,
    #[garde(range(min = 0, max = 999_999))]
    pub started_at_submillis: i64,
    #[garde(range(min = 0))]
    pub finished_at: Option<i64>,
    #[garde(inner(range(min = 0, max = 999_999)))]
    pub finished_at_submillis: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, toasty::Embed)]
pub(super) enum StepStatusRow {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, toasty::Model, Validate)]
#[table = "run_steps"]
#[key(partition = run_id, local = step_id)]
pub(super) struct StepRow {
    #[garde(custom(non_blank))]
    pub run_id: String,
    #[garde(range(min = 1))]
    pub step_id: i64,
    #[garde(range(min = 0))]
    pub sequence: i64,
    #[garde(custom(non_blank))]
    pub node_id: String,
    #[garde(range(min = 1))]
    pub node_execution: i64,
    #[garde(skip)]
    pub selected_edge: Option<String>,
    #[garde(skip)]
    pub status: StepStatusRow,
    #[garde(skip)]
    pub status_message: Option<String>,
    #[garde(skip)]
    pub output: Option<String>,
    #[garde(range(min = 0))]
    pub started_at: i64,
    #[garde(range(min = 0, max = 999_999))]
    pub started_at_submillis: i64,
    #[garde(range(min = 0))]
    pub finished_at: Option<i64>,
    #[garde(inner(range(min = 0, max = 999_999)))]
    pub finished_at_submillis: Option<i64>,
    #[garde(length(min = 1))]
    pub state: String,
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
pub(super) fn non_blank(value: &str, (): &()) -> garde::Result {
    if value.trim().is_empty() {
        Err(garde::Error::new("must not be blank"))
    } else {
        Ok(())
    }
}
