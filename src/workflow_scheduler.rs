use std::collections::HashSet;

use chrono::Utc;
use croner::{
    Cron,
    parser::{CronParser, Seconds},
};
use serde::Serialize;
use tokio::task::JoinSet;

use crate::{
    RunSnapshot, RunTrigger, WorkflowError, WorkflowService,
    workflows::{definition, parse_input, scheduled_input, schedules},
};

/// Policy applied when one schedule fires while its prior run is still active.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub enum ScheduleOverlapPolicy {
    /// Retain a skipped history entry instead of starting another run.
    #[default]
    SkipWhileRunning,
    /// Start every firing regardless of prior active runs.
    AllowOverlap,
}

impl ScheduleOverlapPolicy {
    /// Return the stable display value used by the console.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SkipWhileRunning => "Skip while running",
            Self::AllowOverlap => "Allow overlap",
        }
    }
}

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
    /// Workflow-owned input summary shown in schedule metadata.
    pub input_summary: &'static str,
    /// Behavior when the same schedule already owns an active run.
    pub overlap_policy: ScheduleOverlapPolicy,
}

impl ScheduleSpec {
    /// Construct a schedule using the default skip-while-running policy.
    pub const fn new(
        schedule_id: &'static str,
        workflow_id: &'static str,
        cron_expression: &'static str,
        input_summary: &'static str,
    ) -> Self {
        Self {
            schedule_id,
            workflow_id,
            cron_expression,
            input_summary,
            overlap_policy: ScheduleOverlapPolicy::SkipWhileRunning,
        }
    }

    /// Override the overlap behavior for this schedule.
    #[must_use]
    pub const fn with_overlap_policy(mut self, overlap_policy: ScheduleOverlapPolicy) -> Self {
        self.overlap_policy = overlap_policy;
        self
    }
}

/// Return every code-defined local schedule.
pub const fn workflow_schedules() -> &'static [ScheduleSpec] {
    schedules()
}

impl WorkflowService {
    /// Dispatch one schedule immediately through the shared run boundary.
    pub async fn trigger_schedule(&self, schedule_id: &str) -> Result<RunSnapshot, WorkflowError> {
        let schedule = workflow_schedules()
            .iter()
            .find(|schedule| schedule.schedule_id == schedule_id)
            .ok_or_else(|| WorkflowError::UnknownSchedule {
                schedule_id: schedule_id.to_owned(),
            })?;
        let input = scheduled_input(schedule.workflow_id, schedule.schedule_id)?;
        if schedule.overlap_policy == ScheduleOverlapPolicy::SkipWhileRunning
            && !self.claim_schedule(schedule.schedule_id).await
        {
            return self
                .retain_skipped_schedule(
                    schedule.workflow_id,
                    input,
                    RunTrigger::Cron {
                        schedule_id: schedule.schedule_id.to_owned(),
                    },
                    "the previous run for this schedule is still running",
                )
                .await;
        }
        let result = self
            .start(
                schedule.workflow_id,
                input,
                RunTrigger::Cron {
                    schedule_id: schedule.schedule_id.to_owned(),
                },
            )
            .await;
        if result.is_err() && schedule.overlap_policy == ScheduleOverlapPolicy::SkipWhileRunning {
            self.release_schedule(schedule.schedule_id).await;
        }
        result
    }

    /// Run the code-defined cron dispatcher until its owning server stops.
    pub async fn run_scheduler(&self) -> Result<(), WorkflowError> {
        let schedules = prepared_schedules()?;
        let mut workers = JoinSet::new();
        for (schedule, cron) in schedules {
            let service = self.clone();
            workers.spawn(async move { run_schedule(service, schedule, cron).await });
        }
        match workers.join_next().await {
            Some(Ok(result)) => result,
            Some(Err(error)) => Err(schedule_error(&format!(
                "schedule worker stopped unexpectedly: {error}"
            ))),
            None => Err(schedule_error("no schedule workers were started")),
        }
    }
}

pub(crate) fn validate_schedules() -> Result<(), WorkflowError> {
    let _ = prepared_schedules()?;
    Ok(())
}

fn prepared_schedules() -> Result<Vec<(&'static ScheduleSpec, Cron)>, WorkflowError> {
    let schedule_specs = workflow_schedules();
    if schedule_specs.is_empty() {
        return Err(schedule_error("no schedules configured"));
    }
    let mut ids = HashSet::with_capacity(schedule_specs.len());
    schedule_specs
        .iter()
        .map(|schedule| {
            if !ids.insert(schedule.schedule_id) {
                return Err(schedule_error(&format!(
                    "duplicate schedule ID: {}",
                    schedule.schedule_id
                )));
            }
            if definition(schedule.workflow_id).is_none() {
                return Err(schedule_error(&format!(
                    "schedule {} references unknown workflow {}",
                    schedule.schedule_id, schedule.workflow_id
                )));
            }
            let input = scheduled_input(schedule.workflow_id, schedule.schedule_id)?;
            let _ = parse_input(schedule.workflow_id, input)?;
            let cron = CronParser::builder()
                .seconds(Seconds::Required)
                .build()
                .parse(schedule.cron_expression)
                .map_err(|error| schedule_error(&error.to_string()))?;
            Ok((schedule, cron))
        })
        .collect()
}

async fn run_schedule(
    service: WorkflowService,
    schedule: &'static ScheduleSpec,
    cron: Cron,
) -> Result<(), WorkflowError> {
    loop {
        let now = Utc::now();
        let next = cron
            .find_next_occurrence(&now, false)
            .map_err(|error| schedule_error(&error.to_string()))?;
        let delay = next
            .signed_duration_since(now)
            .to_std()
            .map_err(|error| schedule_error(&error.to_string()))?;
        tokio::time::sleep(delay).await;
        let _ = service.trigger_schedule(schedule.schedule_id).await?;
    }
}

fn schedule_error(message: &str) -> WorkflowError {
    WorkflowError::Schedule {
        message: message.to_owned(),
    }
}
