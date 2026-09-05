use std::time::{Duration, SystemTime};

use serde_json::json;

use super::{RunDto, decode, encode};
use crate::{RunId, RunInput, RunSnapshot, RunStatus, RunTrigger, StepState, WorkflowError};

fn running() -> RunSnapshot {
    RunSnapshot {
        run_id: RunId("test-run".to_owned()),
        workflow_id: "demo".to_owned(),
        input: RunInput::new(json!({"choice": "left"}), "Left route".to_owned()),
        trigger: RunTrigger::Manual,
        status: RunStatus::Running,
        current_node: Some("start".to_owned()),
        current_edge: None,
        traversed_nodes: Vec::new(),
        traversed_edges: Vec::new(),
        route_summary: "start".to_owned(),
        started_at: SystemTime::UNIX_EPOCH,
        finished_at: None,
        duration: None,
        steps: Vec::new(),
    }
}

#[test]
fn snapshot_storage_round_trip_preserves_nested_state_and_trace() -> Result<(), WorkflowError> {
    let mut run = running();
    let step_id = run.begin_step("start");
    run.finish_step(
        step_id,
        Some("start-end"),
        Some("output".to_owned()),
        StepState {
            payload: json!({"nested": [null, true, {"unicode": "日本語"}]}),
        },
    );
    run.status = RunStatus::Completed;
    run.traversed_nodes.push("start".to_owned());
    run.traversed_edges.push("start-end".to_owned());
    run.current_edge = Some("start-end".to_owned());
    run.finished_at = Some(SystemTime::now());
    run.duration = run
        .finished_at
        .and_then(|end| end.duration_since(run.started_at).ok());
    let encoded = encode(&run)?;
    let restored = decode(&encoded)?;
    assert_eq!(encode(&restored)?, encoded);
    Ok(())
}

#[test]
fn invalid_json_is_a_storage_error() {
    assert!(matches!(decode("{"), Err(WorkflowError::Storage { .. })));
}

#[test]
fn blank_identifier_is_rejected_by_boundary_validation() -> Result<(), Box<dyn std::error::Error>> {
    let mut dto = RunDto::from(&running());
    dto.run_id = "  ".to_owned();
    assert!(matches!(
        decode(&serde_json::to_string(&dto)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn unsupported_payload_version_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let mut dto = RunDto::from(&running());
    dto.version = 2;
    assert!(matches!(
        decode(&serde_json::to_string(&dto)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn non_object_input_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let mut dto = RunDto::from(&running());
    dto.input = json!([1, 2]);
    assert!(matches!(
        decode(&serde_json::to_string(&dto)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn terminal_status_requires_finish_time() -> Result<(), Box<dyn std::error::Error>> {
    let mut run = running();
    run.status = RunStatus::Completed;
    assert!(matches!(
        decode(&encode(&run)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn inconsistent_duration_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let mut run = running();
    run.status = RunStatus::Completed;
    run.finished_at = Some(SystemTime::UNIX_EPOCH);
    run.duration = Some(Duration::from_secs(1));
    assert!(matches!(
        decode(&encode(&run)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn duplicate_step_identity_is_rejected_in_domain_construction()
-> Result<(), Box<dyn std::error::Error>> {
    let mut run = running();
    let step_id = run.begin_step("start");
    run.finish_step(step_id, None, None, StepState { payload: json!({}) });
    run.traversed_nodes.push("start".to_owned());
    let _ = run.begin_step("start");
    let mut dto = RunDto::from(&run);
    if let Some(step) = dto.steps.last_mut() {
        step.step_id = 1;
    }
    assert!(matches!(
        decode(&serde_json::to_string(&dto)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn inconsistent_node_execution_count_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let mut run = running();
    let _ = run.begin_step("start");
    let mut dto = RunDto::from(&run);
    if let Some(step) = dto.steps.first_mut() {
        step.node_execution = 2;
    }
    assert!(matches!(
        decode(&serde_json::to_string(&dto)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn terminal_run_cannot_contain_running_step() -> Result<(), Box<dyn std::error::Error>> {
    let mut run = running();
    let _ = run.begin_step("start");
    run.status = RunStatus::Completed;
    run.finished_at = Some(SystemTime::now());
    run.duration = run
        .finished_at
        .and_then(|end| end.duration_since(run.started_at).ok());
    assert!(matches!(
        decode(&encode(&run)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn known_workflow_input_is_revalidated_after_loading() -> Result<(), Box<dyn std::error::Error>> {
    let mut dto = RunDto::from(&running());
    dto.workflow_id = "demo-workflow".to_owned();
    dto.input = json!({"label": "valid label", "step_delay_ms": 0});
    assert!(matches!(
        decode(&serde_json::to_string(&dto)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn traversal_must_agree_with_completed_trace_nodes() -> Result<(), Box<dyn std::error::Error>> {
    let mut dto = RunDto::from(&running());
    dto.traversed_nodes.push("not-executed".to_owned());
    assert!(matches!(
        decode(&serde_json::to_string(&dto)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn valid_skipped_run_round_trips_without_executed_steps() -> Result<(), WorkflowError> {
    let mut run = running();
    run.status = RunStatus::Skipped {
        reason: "previous run is active".to_owned(),
    };
    run.trigger = RunTrigger::Cron {
        schedule_id: "test-schedule".to_owned(),
    };
    run.finished_at = Some(run.started_at);
    run.duration = Some(Duration::ZERO);
    let encoded = encode(&run)?;
    assert_eq!(encode(&decode(&encoded)?)?, encoded);
    Ok(())
}

#[test]
fn valid_failed_run_round_trips_with_failed_step() -> Result<(), WorkflowError> {
    let mut run = running();
    let step_id = run.begin_step("start");
    let finished_at = SystemTime::now();
    run.fail_step(Some(step_id), "failure", finished_at);
    run.status = RunStatus::Failed {
        message: "failure".to_owned(),
    };
    run.finished_at = Some(finished_at);
    run.duration = finished_at.duration_since(run.started_at).ok();
    let encoded = encode(&run)?;
    assert_eq!(encode(&decode(&encoded)?)?, encoded);
    Ok(())
}
