use chrono::Utc;
use croner::parser::{CronParser, Seconds};
use serde::Serialize;

use crate::{RunInput, RunSnapshot, RunTrigger, WorkflowError, WorkflowService};

/// One cron schedule declared directly in the application.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct ScheduleSpec {
    /// Stable schedule identifier.
    pub schedule_id: &'static str,
    /// Workflow started by this schedule.
    pub workflow_id: &'static str,
    /// Six-field cron expression including seconds.
    pub cron_expression: &'static str,
    /// Label inserted into the initial graph context.
    pub input_label: &'static str,
    /// Per-node delay inserted into the initial graph context.
    pub step_delay_ms: u64,
}

const SCHEDULES: [ScheduleSpec; 1] = [ScheduleSpec {
    schedule_id: "demo-every-10-seconds",
    workflow_id: "demo-workflow",
    cron_expression: "*/10 * * * * *",
    input_label: "scheduled heartbeat",
    step_delay_ms: 250,
}];

/// Return every code-defined local schedule.
pub const fn workflow_schedules() -> &'static [ScheduleSpec] {
    &SCHEDULES
}

impl WorkflowService {
    /// Dispatch one schedule immediately through the shared run boundary.
    pub async fn trigger_schedule(&self, schedule_id: &str) -> Result<RunSnapshot, WorkflowError> {
        let schedule = SCHEDULES
            .iter()
            .find(|schedule| schedule.schedule_id == schedule_id)
            .ok_or_else(|| WorkflowError::UnknownSchedule {
                schedule_id: schedule_id.to_owned(),
            })?;
        let input = RunInput::new(schedule.input_label, schedule.step_delay_ms)?;
        self.start(
            schedule.workflow_id,
            input,
            RunTrigger::Cron {
                schedule_id: schedule.schedule_id.to_owned(),
            },
        )
        .await
    }

    /// Run the code-defined cron dispatcher until its owning server stops.
    pub async fn run_scheduler(&self) -> Result<(), WorkflowError> {
        let schedule = SCHEDULES.first().ok_or_else(|| WorkflowError::Schedule {
            message: "no schedules configured".to_owned(),
        })?;
        let cron = CronParser::builder()
            .seconds(Seconds::Required)
            .build()
            .parse(schedule.cron_expression)
            .map_err(|error| WorkflowError::Schedule {
                message: error.to_string(),
            })?;
        loop {
            let now = Utc::now();
            let next = cron.find_next_occurrence(&now, false).map_err(|error| {
                WorkflowError::Schedule {
                    message: error.to_string(),
                }
            })?;
            let delay = next.signed_duration_since(now).to_std().map_err(|error| {
                WorkflowError::Schedule {
                    message: error.to_string(),
                }
            })?;
            tokio::time::sleep(delay).await;
            self.trigger_schedule(schedule.schedule_id).await?;
        }
    }
}
