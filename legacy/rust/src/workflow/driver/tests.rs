use std::time::{Duration, SystemTime};

use serde_json::json;

use super::step_limit_failure;
use crate::{
    ExecutionLimit, RunId, RunInput, RunSnapshot, RunStatus, RunTrigger, WorkflowExecutionLimits,
};

#[test]
fn step_limit_rejects_the_next_execution_after_node_and_workflow_budgets() {
    // Given: five retained executions of one self-referencing node.
    let mut snapshot = snapshot();
    for _ in 0..5 {
        let _ = snapshot.begin_step("loop");
    }
    let node_limited = WorkflowExecutionLimits::new(
        10,
        Duration::from_mins(10),
        ExecutionLimit::new(5, Duration::from_mins(5)),
    );
    let workflow_limited = WorkflowExecutionLimits::new(
        5,
        Duration::from_mins(10),
        ExecutionLimit::new(10, Duration::from_mins(5)),
    );

    // When: the driver checks whether another loop iteration may start.
    let node_error = step_limit_failure(&snapshot, "loop", node_limited);
    let workflow_error = step_limit_failure(&snapshot, "other", workflow_limited);

    // Then: each independent budget rejects the next execution.
    assert_eq!(
        node_error.as_deref(),
        Some("node loop exceeded its execution limit of 5")
    );
    assert_eq!(
        workflow_error.as_deref(),
        Some("workflow exceeded its total step limit of 5")
    );
}

fn snapshot() -> RunSnapshot {
    RunSnapshot {
        run_id: RunId("limit-test".to_owned()),
        workflow_id: "limit-test".to_owned(),
        input: RunInput::new(json!({}), String::new()),
        trigger: RunTrigger::Manual,
        status: RunStatus::Running,
        current_node: Some("loop".to_owned()),
        current_edge: None,
        traversed_nodes: Vec::new(),
        traversed_edges: Vec::new(),
        route_summary: "loop".to_owned(),
        started_at: SystemTime::now(),
        finished_at: None,
        duration: None,
        steps: Vec::new(),
    }
}
