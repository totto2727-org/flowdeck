//! Integration coverage for workflow lifecycle notifications.

use std::time::Duration;

use flowdeck::{RunId, RunStatus, RunTrigger, StepTraceStatus, WorkflowEvent, WorkflowService};
use serde_json::json;

#[tokio::test]
async fn workflow_events_when_run_executes_are_ordered_and_snapshot_consistent() {
    // Given: a subscriber attached before a workflow begins.
    let service = WorkflowService::new().expect("the code-defined workflows should build");
    let mut events = service.subscribe();

    // When: the workflow is started and driven to its terminal state.
    let started = service
        .start(
            "review-pipeline",
            json!({ "subject": "release candidate", "reviewer": "local operator" }),
            RunTrigger::Manual,
        )
        .await
        .expect("the linear workflow should start");
    let mut received = Vec::new();
    for _ in 0..10 {
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("each lifecycle notification should arrive")
            .expect("the subscribed receiver should not lag");
        assert_snapshot_matches_event(&service, &event)
            .await
            .expect("event and retained snapshot should agree");
        received.push(event);
    }

    // Then: every lifecycle transition is observable after its snapshot mutation.
    let [
        started_event,
        receive_started,
        receive_completed,
        inspect_started,
        inspect_completed,
        approve_started,
        approve_completed,
        archive_started,
        archive_completed,
        completed_event,
    ] = received.as_slice()
    else {
        panic!("the workflow should emit ten ordered lifecycle notifications");
    };
    assert!(
        matches!(started_event, WorkflowEvent::RunStarted { run_id, workflow_id } if *run_id == started.run_id && workflow_id == "review-pipeline")
    );
    assert!(
        matches!(receive_started, WorkflowEvent::NodeStarted { node_id, .. } if node_id == "receive")
    );
    assert!(
        matches!(receive_completed, WorkflowEvent::NodeCompleted { node_id, edge_id, .. } if node_id == "receive" && edge_id.as_deref() == Some("receive-to-inspect"))
    );
    assert!(
        matches!(inspect_started, WorkflowEvent::NodeStarted { node_id, .. } if node_id == "inspect")
    );
    assert!(
        matches!(inspect_completed, WorkflowEvent::NodeCompleted { node_id, edge_id, .. } if node_id == "inspect" && edge_id.as_deref() == Some("inspect-to-approve"))
    );
    assert!(
        matches!(approve_started, WorkflowEvent::NodeStarted { node_id, .. } if node_id == "approve")
    );
    assert!(
        matches!(approve_completed, WorkflowEvent::NodeCompleted { node_id, edge_id, .. } if node_id == "approve" && edge_id.as_deref() == Some("approve-to-archive"))
    );
    assert!(
        matches!(archive_started, WorkflowEvent::NodeStarted { node_id, .. } if node_id == "archive")
    );
    assert!(
        matches!(archive_completed, WorkflowEvent::NodeCompleted { node_id, edge_id, .. } if node_id == "archive" && edge_id.is_none())
    );
    assert!(
        matches!(completed_event, WorkflowEvent::RunCompleted { run_id, .. } if *run_id == started.run_id)
    );
}

async fn assert_snapshot_matches_event(
    service: &WorkflowService,
    event: &WorkflowEvent,
) -> Result<(), Box<dyn std::error::Error>> {
    let run_id = event_run_id(event);
    let snapshot = service
        .get_run(run_id)
        .await
        .ok_or_else(|| std::io::Error::other("event run should be retained"))?;
    match event {
        WorkflowEvent::RunStarted { workflow_id, .. } => {
            assert_eq!(snapshot.workflow_id, *workflow_id);
        }
        WorkflowEvent::NodeStarted {
            node_id, step_id, ..
        } => {
            assert!(
                snapshot
                    .steps
                    .iter()
                    .any(|step| step.node_id == *node_id && step.step_id == *step_id)
            );
        }
        WorkflowEvent::NodeCompleted {
            node_id,
            step_id,
            edge_id,
            ..
        } => {
            let step = snapshot
                .steps
                .iter()
                .find(|step| step.step_id == *step_id)
                .ok_or_else(|| std::io::Error::other("completed step should be retained"))?;
            assert_eq!(step.node_id, *node_id);
            assert_eq!(step.status, StepTraceStatus::Completed);
            assert_eq!(step.selected_edge.as_deref(), edge_id.as_deref());
        }
        WorkflowEvent::RunCompleted { .. } => {
            assert!(matches!(snapshot.status, RunStatus::Completed));
        }
        WorkflowEvent::RunFailed { .. } | WorkflowEvent::RunSkipped { .. } => {
            return Err(std::io::Error::other("linear workflow stopped early").into());
        }
    }
    Ok(())
}

const fn event_run_id(event: &WorkflowEvent) -> &RunId {
    match event {
        WorkflowEvent::RunStarted { run_id, .. }
        | WorkflowEvent::NodeStarted { run_id, .. }
        | WorkflowEvent::NodeCompleted { run_id, .. }
        | WorkflowEvent::RunCompleted { run_id, .. }
        | WorkflowEvent::RunFailed { run_id, .. }
        | WorkflowEvent::RunSkipped { run_id, .. } => run_id,
    }
}
