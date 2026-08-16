//! Integration coverage for the local workflow execution boundary.

use std::time::Duration;

use workflow_console_experiment::{
    RunInput, RunStatus, RunTrigger, StepTraceStatus, WorkflowError, WorkflowService,
    workflow_definitions, workflow_id,
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

    assert_eq!(terminal.steps.len(), 5);
    assert!(
        terminal
            .steps
            .iter()
            .all(|step| step.status == StepTraceStatus::Completed)
    );
    assert!(terminal.steps.iter().all(|step| step.duration.is_some()));
    assert!(terminal.steps.iter().all(|step| step.output.is_some()));
    let first_step = terminal.steps.first().expect("prepare trace should exist");
    assert_eq!(first_step.node_id, "prepare");
    assert_eq!(
        first_step.selected_edge.as_deref(),
        Some("prepare-to-choose")
    );
    assert_eq!(first_step.state.run_label, "terminal check");
    assert_eq!(first_step.state.step_delay_ms, 350);
    assert!(first_step.state.task_token.is_some());

    let choose = terminal
        .steps
        .iter()
        .find(|step| step.node_id == "choose_route")
        .expect("route selection trace should be retained");
    assert!(choose.state.branch_selected.is_some());
    assert!(choose.state.branch_token.is_some());
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

#[tokio::test]
async fn every_code_defined_workflow_can_be_selected_and_completed() {
    let service = WorkflowService::new().expect("every code-defined workflow should build");
    let definitions = workflow_definitions();
    let demo = definitions
        .iter()
        .find(|definition| definition.workflow_id == "demo-workflow")
        .expect("demo workflow is registered");
    let review = definitions
        .iter()
        .find(|definition| definition.workflow_id == "review-pipeline")
        .expect("review workflow is registered");

    assert_eq!(definitions.len(), 2);
    assert_ne!(demo.nodes, review.nodes);

    let started = service
        .start(
            review.workflow_id,
            RunInput::new("select the review pipeline", 100).expect("valid input"),
            RunTrigger::Manual,
        )
        .await
        .expect("the selected workflow starts");

    let terminal = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let snapshot = service
                .get_run(&started.run_id)
                .await
                .expect("started run remains in history");
            if matches!(snapshot.status, RunStatus::Completed) {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the selected workflow should finish within its timing bound");

    assert_eq!(terminal.workflow_id, "review-pipeline");
    assert_eq!(
        terminal.traversed_nodes.first().map(String::as_str),
        Some("receive")
    );
    assert_eq!(
        terminal.traversed_nodes.last().map(String::as_str),
        Some("archive")
    );
    assert_eq!(terminal.traversed_nodes.len(), 4);
}
