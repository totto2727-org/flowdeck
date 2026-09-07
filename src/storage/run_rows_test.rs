use std::time::{Duration, SystemTime};

use serde_json::json;

use super::{RunRow, StepRow, timestamp_from_optional_columns, timestamp_to_columns};
use crate::{
    RunId, RunInput, RunSnapshot, RunStatus, RunTrigger, StepId, StepState, StepTrace,
    StepTraceStatus,
};

#[test]
fn timestamp_columns_restore_exact_system_time() -> Result<(), Box<dyn std::error::Error>> {
    let time = SystemTime::UNIX_EPOCH
        .checked_add(Duration::new(123, 456_789_123))
        .ok_or("timestamp overflow")?;
    let (millis, submillis) = timestamp_to_columns(time)?;

    assert_eq!((millis, submillis), (123_456, 789_123));
    assert_eq!(
        timestamp_from_optional_columns(Some(millis), Some(submillis))?,
        Some(time)
    );
    Ok(())
}

#[test]
fn timestamp_columns_reject_an_incomplete_precise_timestamp() {
    assert!(timestamp_from_optional_columns(Some(1), None).is_err());
    assert!(timestamp_from_optional_columns(None, Some(1)).is_err());
}

#[test]
fn from_snapshot_rejects_an_incorrect_duration() -> Result<(), Box<dyn std::error::Error>> {
    let mut snapshot = completed_snapshot()?;
    snapshot.duration = Some(Duration::ZERO);

    assert!(RunRow::from_snapshot(&snapshot).is_err());
    Ok(())
}

#[test]
fn from_snapshot_rejects_an_incorrect_traversal() -> Result<(), Box<dyn std::error::Error>> {
    let mut snapshot = completed_snapshot()?;
    snapshot.traversed_nodes = vec!["wrong-node".to_owned()];

    assert!(RunRow::from_snapshot(&snapshot).is_err());
    Ok(())
}

#[test]
fn restoration_rejects_an_invalid_step_sequence() -> Result<(), Box<dyn std::error::Error>> {
    let snapshot = completed_snapshot()?;
    let row = RunRow::from_snapshot(&snapshot)?;
    let trace = snapshot.steps.first().ok_or("missing fixture step")?;
    let mut step = StepRow::from_trace(snapshot.run_id.as_str(), trace)?;
    step.sequence = 1;

    assert!(row.into_snapshot(vec![step]).is_err());
    Ok(())
}

fn completed_snapshot() -> Result<RunSnapshot, Box<dyn std::error::Error>> {
    let started_at = SystemTime::UNIX_EPOCH
        .checked_add(Duration::new(1, 234_567_890))
        .ok_or("timestamp overflow")?;
    let finished_at = started_at
        .checked_add(Duration::new(2, 345_678_901))
        .ok_or("timestamp overflow")?;
    Ok(RunSnapshot {
        run_id: RunId("run".to_owned()),
        workflow_id: "removed-workflow".to_owned(),
        input: RunInput::new(json!({"input": true}), "input".to_owned()),
        trigger: RunTrigger::Manual,
        status: RunStatus::Completed,
        current_node: Some("finish".to_owned()),
        current_edge: Some("finish-edge".to_owned()),
        traversed_nodes: vec!["finish".to_owned()],
        traversed_edges: vec!["finish-edge".to_owned()],
        route_summary: "finish".to_owned(),
        started_at,
        finished_at: Some(finished_at),
        duration: Some(finished_at.duration_since(started_at)?),
        steps: vec![StepTrace {
            step_id: StepId::from_persisted(1)?,
            sequence: 0,
            node_id: "finish".to_owned(),
            node_execution: 1,
            selected_edge: Some("finish-edge".to_owned()),
            status: StepTraceStatus::Completed,
            state: StepState {
                payload: json!({"nested": {"value": true}}),
            },
            output: Some("done".to_owned()),
            started_at,
            finished_at: Some(finished_at),
            duration: Some(finished_at.duration_since(started_at)?),
        }],
    })
}
