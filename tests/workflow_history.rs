//! Integration coverage for the local workflow execution boundary.

use std::time::Duration;

use workflow_console_experiment::{
    RunInput, RunStatus, RunTrigger, WorkflowError, WorkflowService, workflow_id,
};

#[tokio::test]
async fn workflow_history_when_duplicate_or_malformed_request() {
    let service = WorkflowService::new().expect("the code-defined workflow should build");

    let first = service
        .start(
            workflow_id(),
            RunInput::new("manual check", 350).expect("valid input"),
            RunTrigger::Manual,
        )
        .await
        .expect("valid workflow starts");
    let second = service
        .start(
            workflow_id(),
            RunInput::new("second check", 350).expect("valid input"),
            RunTrigger::Manual,
        )
        .await
        .expect("valid workflow starts twice");

    assert_ne!(first.run_id, second.run_id);
    assert!(matches!(
        service
            .start(
                "not-a-workflow",
                RunInput::new("rejected", 350).expect("valid input"),
                RunTrigger::Manual,
            )
            .await,
        Err(WorkflowError::UnknownWorkflow { .. })
    ));

    let history = service.list_runs().await;
    assert_eq!(history.len(), 2);
    assert!(
        history
            .iter()
            .all(|snapshot| matches!(snapshot.status, RunStatus::Running))
    );
}

#[tokio::test]
async fn workflow_reaches_terminal_after_observable_steps() {
    let service = WorkflowService::new().expect("the code-defined workflow should build");
    let started = service
        .start(
            workflow_id(),
            RunInput::new("terminal check", 350).expect("valid input"),
            RunTrigger::Manual,
        )
        .await
        .expect("valid workflow starts");

    let terminal = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let snapshot = service
                .get_run(&started.run_id)
                .await
                .expect("started run remains in history");
            if matches!(snapshot.status, RunStatus::Completed) {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .expect("workflow should finish within its timing bound");

    assert_eq!(terminal.current_node.as_deref(), Some("complete"));
    assert_eq!(
        terminal.traversed_nodes.first().map(String::as_str),
        Some("prepare")
    );
    assert_eq!(
        terminal.traversed_nodes.last().map(String::as_str),
        Some("complete")
    );
    assert!(terminal.route_summary.contains("choose_route"));
    assert!(terminal.finished_at.is_some());
    assert!(terminal.duration.is_some());
}

#[tokio::test]
async fn run_input_becomes_initial_state_when_manual_run_starts() {
    let service = WorkflowService::new().expect("the code-defined workflow should build");
    let input = RunInput::new("release candidate", 240).expect("valid input");

    let started = service
        .start(workflow_id(), input.clone(), RunTrigger::Manual)
        .await
        .expect("manual workflow starts");

    assert_eq!(started.input, input);
    assert_eq!(started.trigger, RunTrigger::Manual);
}

#[tokio::test]
async fn cron_schedule_uses_configured_input_when_dispatched() {
    let service = WorkflowService::new().expect("the code-defined workflow should build");

    let started = service
        .trigger_schedule("demo-every-10-seconds")
        .await
        .expect("code-defined schedule dispatches");

    assert_eq!(started.input.label(), "scheduled heartbeat");
    assert_eq!(started.input.step_delay_ms(), 250);
    assert_eq!(
        started.trigger,
        RunTrigger::Cron {
            schedule_id: "demo-every-10-seconds".to_owned(),
        }
    );
}
