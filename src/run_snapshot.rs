use crate::{RunSnapshot, RunStatus, StepTrace, StepTraceStatus, WorkflowError};

impl RunSnapshot {
    /// Reconstruct a persisted run only when its lifecycle and trace agree.
    pub(crate) fn restore(snapshot: Self) -> Result<Self, WorkflowError> {
        let running = snapshot.status == RunStatus::Running;
        validate_timing(
            snapshot.started_at,
            snapshot.finished_at,
            snapshot.duration,
            running,
        )?;
        validate_route(&snapshot)?;
        let mut executions = std::collections::HashMap::<&str, usize>::new();
        for (sequence, step) in snapshot.steps.iter().enumerate() {
            let expected = sequence
                .checked_add(1)
                .ok_or_else(|| invalid("step identity overflow"))?;
            let execution = executions.entry(step.node_id.as_str()).or_default();
            *execution = execution
                .checked_add(1)
                .ok_or_else(|| invalid("node execution count overflow"))?;
            if step.sequence != sequence
                || step.step_id.value() != expected
                || step.node_execution != *execution
            {
                return Err(invalid(
                    "step order, identity, or execution count is inconsistent",
                ));
            }
            validate_step_timing(&snapshot, step, expected)?;
        }
        Ok(snapshot)
    }
}

fn validate_route(snapshot: &RunSnapshot) -> Result<(), WorkflowError> {
    let completed_nodes = snapshot
        .steps
        .iter()
        .filter(|step| step.status == StepTraceStatus::Completed)
        .map(|step| step.node_id.as_str());
    let selected_edges: Vec<_> = snapshot
        .steps
        .iter()
        .filter_map(|step| step.selected_edge.as_deref())
        .collect();
    if !completed_nodes.eq(snapshot.traversed_nodes.iter().map(String::as_str))
        || !selected_edges
            .iter()
            .copied()
            .eq(snapshot.traversed_edges.iter().map(String::as_str))
        || snapshot.current_edge.as_deref() != selected_edges.last().copied()
    {
        return Err(invalid("traversed route disagrees with step traces"));
    }
    if matches!(snapshot.status, RunStatus::Skipped { .. }) && !snapshot.steps.is_empty() {
        return Err(invalid("skipped run contains executed steps"));
    }
    Ok(())
}

fn validate_step_timing(
    snapshot: &RunSnapshot,
    step: &StepTrace,
    expected: usize,
) -> Result<(), WorkflowError> {
    let running = snapshot.status == RunStatus::Running;
    let step_running = step.status == StepTraceStatus::Running;
    if matches!(step.status, StepTraceStatus::Failed { .. })
        && (!matches!(snapshot.status, RunStatus::Failed { .. })
            || expected != snapshot.steps.len())
    {
        return Err(invalid("failed step disagrees with run status or order"));
    }
    if step.status != StepTraceStatus::Completed && step.selected_edge.is_some() {
        return Err(invalid("unfinished step has a selected edge"));
    }
    validate_timing(
        step.started_at,
        step.finished_at,
        step.duration,
        step_running,
    )?;
    if (step_running && (!running || expected != snapshot.steps.len()))
        || step.started_at < snapshot.started_at
        || step
            .finished_at
            .zip(snapshot.finished_at)
            .is_some_and(|(step_end, run_end)| step_end > run_end)
    {
        return Err(invalid("step lifecycle disagrees with run lifecycle"));
    }
    Ok(())
}

fn validate_timing(
    started: std::time::SystemTime,
    finished: Option<std::time::SystemTime>,
    duration: Option<std::time::Duration>,
    running: bool,
) -> Result<(), WorkflowError> {
    if running != finished.is_none() || finished.is_some() != duration.is_some() {
        return Err(invalid("lifecycle timestamps disagree with status"));
    }
    if let Some(finished) = finished {
        let elapsed = finished
            .duration_since(started)
            .map_err(|_| invalid("execution finishes before it starts"))?;
        if duration != Some(elapsed) {
            return Err(invalid("duration disagrees with timestamps"));
        }
    }
    Ok(())
}

fn invalid(message: &str) -> WorkflowError {
    WorkflowError::Storage {
        message: format!("invalid persisted run: {message}"),
    }
}
