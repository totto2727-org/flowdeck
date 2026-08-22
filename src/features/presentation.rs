use std::time::{Duration, SystemTime, UNIX_EPOCH};

use workflow_console_experiment::{RunSnapshot, RunStatus, RunTrigger, StepTrace, StepTraceStatus};

pub(crate) const fn run_status(run: &RunSnapshot) -> &'static str {
    match run.status {
        RunStatus::Running => "Running",
        RunStatus::Completed => "Completed",
        RunStatus::Failed { .. } => "Failed",
        RunStatus::Skipped { .. } => "Skipped",
    }
}

pub(crate) const fn step_status(step: &StepTrace) -> &'static str {
    match step.status {
        StepTraceStatus::Running => "Running",
        StepTraceStatus::Completed => "Completed",
        StepTraceStatus::Failed { .. } => "Failed",
    }
}

pub(crate) fn trigger(run: &RunSnapshot) -> String {
    match &run.trigger {
        RunTrigger::Manual => "Manual".to_owned(),
        RunTrigger::Cron { schedule_id } => format!("Cron · {schedule_id}"),
    }
}

pub(crate) fn elapsed(run: &RunSnapshot) -> String {
    let duration = run
        .duration
        .or_else(|| SystemTime::now().duration_since(run.started_at).ok());
    format_duration(duration)
}

pub(crate) fn step_elapsed(step: &StepTrace) -> String {
    let duration = step
        .duration
        .or_else(|| SystemTime::now().duration_since(step.started_at).ok());
    format_duration(duration)
}

pub(crate) fn timestamp(value: Option<SystemTime>) -> String {
    value
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or_else(
            || "—".to_owned(),
            |duration| format!("{} ms", duration.as_millis()),
        )
}

pub(crate) const fn state_label(active: bool, traversed: bool) -> &'static str {
    if active {
        "Active"
    } else if traversed {
        "Traversed"
    } else {
        "Idle"
    }
}

pub(crate) const fn state_value(active: bool, traversed: bool) -> &'static str {
    if active {
        "active"
    } else if traversed {
        "traversed"
    } else {
        "idle"
    }
}

fn format_duration(duration: Option<Duration>) -> String {
    duration.map_or_else(
        || "—".to_owned(),
        |value| format!("{} ms", value.as_millis()),
    )
}
