//! Integration coverage for the local workflow execution boundary.

use std::{num::NonZeroUsize, time::Duration};

use flowdeck::{
    ApplicationConfig, RunStatus, RunTrigger, ScheduleOverlapPolicy, SchedulerMode,
    StateBackendConfig, StepTraceStatus, WorkflowError, WorkflowEvent, WorkflowService,
    workflow_definitions, workflow_id, workflow_schedules,
};
use serde_json::json;

#[tokio::test]
async fn workflow_history_when_duplicate_or_malformed_request() {
    let service = WorkflowService::new()
        .await
        .expect("the code-defined workflow should build");

    let first = service
        .start(
            workflow_id(),
            json!({ "label": "manual check", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await
        .expect("valid workflow starts");
    let second = service
        .start(
            workflow_id(),
            json!({ "label": "second check", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await
        .expect("valid workflow starts twice");

    assert_ne!(first.run_id, second.run_id);
    assert!(matches!(
        service
            .start(
                "not-a-workflow",
                json!({ "label": "rejected", "step_delay_ms": 350 }),
                RunTrigger::Manual,
            )
            .await,
        Err(WorkflowError::UnknownWorkflow { .. })
    ));

    let history = service.list_runs().await.expect("run history should load");
    assert_eq!(history.len(), 2);
    assert!(
        history
            .iter()
            .all(|snapshot| matches!(snapshot.status, RunStatus::Running))
    );
}

#[tokio::test]
async fn workflow_reaches_terminal_after_observable_steps() {
    let service = WorkflowService::new()
        .await
        .expect("the code-defined workflow should build");
    let started = service
        .start(
            workflow_id(),
            json!({ "label": "terminal check", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await
        .expect("valid workflow starts");

    let terminal = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let snapshot = service
                .get_run(&started.run_id)
                .await
                .expect("run storage should load")
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
    assert_eq!(
        first_step
            .state
            .payload
            .get("input")
            .and_then(|input| input.get("label")),
        Some(&json!("terminal check"))
    );
    assert_eq!(
        first_step
            .state
            .payload
            .get("input")
            .and_then(|input| input.get("step_delay_ms")),
        Some(&json!(350))
    );
    assert!(
        first_step
            .state
            .payload
            .get("task_token")
            .is_some_and(serde_json::Value::is_string)
    );

    let choose = terminal
        .steps
        .iter()
        .find(|step| step.node_id == "choose_route")
        .expect("route selection trace should be retained");
    assert!(
        choose
            .state
            .payload
            .get("branch_selected")
            .is_some_and(serde_json::Value::is_boolean)
    );
    assert!(
        choose
            .state
            .payload
            .get("branch_token")
            .is_some_and(serde_json::Value::is_string)
    );
}

#[tokio::test]
async fn run_input_becomes_initial_state_when_manual_run_starts() {
    let service = WorkflowService::new()
        .await
        .expect("the code-defined workflow should build");
    let input = json!({ "label": "release candidate", "step_delay_ms": 240 });

    let started = service
        .start(workflow_id(), input.clone(), RunTrigger::Manual)
        .await
        .expect("manual workflow starts");

    assert_eq!(started.input.state(), &input);
    assert_eq!(started.input.summary(), "release candidate · 240 ms");
    assert_eq!(started.trigger, RunTrigger::Manual);
}

#[tokio::test]
async fn cron_schedule_uses_configured_input_when_dispatched() {
    let service = WorkflowService::new()
        .await
        .expect("the code-defined workflow should build");

    let started = service
        .trigger_schedule("demo-every-10-seconds")
        .await
        .expect("code-defined schedule dispatches");

    assert_eq!(
        started.input.state(),
        &json!({ "label": "scheduled heartbeat", "step_delay_ms": 250 })
    );
    assert_eq!(started.input.summary(), "scheduled heartbeat · 250 ms");
    assert_eq!(
        started.trigger,
        RunTrigger::Cron {
            schedule_id: "demo-every-10-seconds".to_owned(),
        }
    );
}

#[tokio::test]
async fn cron_schedule_skips_overlap_and_retains_the_skipped_attempt() {
    // Given: the default schedule has one run in progress.
    let service = WorkflowService::new()
        .await
        .expect("the code-defined workflow should build");
    let running = service
        .trigger_schedule("demo-every-10-seconds")
        .await
        .expect("the first scheduled run should start");

    // When: the same schedule fires before that run completes.
    let skipped = service
        .trigger_schedule("demo-every-10-seconds")
        .await
        .expect("a skipped schedule attempt should still be retained");

    // Then: the attempt is visible in history without starting graph execution.
    assert!(matches!(running.status, RunStatus::Running));
    assert!(matches!(skipped.status, RunStatus::Skipped { .. }));
    assert!(skipped.steps.is_empty());
    assert!(skipped.finished_at.is_some());
    assert_eq!(
        service
            .list_runs()
            .await
            .expect("run history should load")
            .len(),
        2
    );
}

#[tokio::test]
async fn cron_schedule_allows_overlap_when_configured() {
    // Given: a schedule explicitly configured to allow overlap.
    let service = WorkflowService::new()
        .await
        .expect("the code-defined workflow should build");

    // When: it fires twice without waiting for the first run.
    let first = service
        .trigger_schedule("demo-every-15-seconds-overlap")
        .await
        .expect("the first overlapping run should start");
    let second = service
        .trigger_schedule("demo-every-15-seconds-overlap")
        .await
        .expect("the second overlapping run should start");

    // Then: both attempts are active graph runs instead of skipped history entries.
    assert!(matches!(first.status, RunStatus::Running));
    assert!(matches!(second.status, RunStatus::Running));
    assert_ne!(first.run_id, second.run_id);
}

#[tokio::test]
async fn inherited_schedule_policy_uses_application_configuration() {
    let mut config = ApplicationConfig::local_default();
    config.scheduler.default_overlap_policy = ScheduleOverlapPolicy::AllowOverlap;
    let service = WorkflowService::with_config(config)
        .await
        .expect("configured workflows should build");

    let first = service
        .trigger_schedule("demo-every-10-seconds")
        .await
        .expect("the first inherited schedule run should start");
    let second = service
        .trigger_schedule("demo-every-10-seconds")
        .await
        .expect("the configured inherited policy should allow overlap");

    assert!(matches!(first.status, RunStatus::Running));
    assert!(matches!(second.status, RunStatus::Running));
}

#[tokio::test]
async fn disabled_scheduler_keeps_manual_service_available_without_workers() {
    let mut config = ApplicationConfig::local_default();
    config.scheduler.mode = SchedulerMode::Disabled;
    let service = WorkflowService::with_config(config)
        .await
        .expect("disabled scheduler should build");

    assert!(
        tokio::time::timeout(Duration::from_millis(20), service.run_scheduler())
            .await
            .is_err()
    );
    let started = service
        .start(
            "review-pipeline",
            json!({ "subject": "manual only", "reviewer": "operator" }),
            RunTrigger::Manual,
        )
        .await
        .expect("manual execution remains available");
    assert!(matches!(started.status, RunStatus::Running));
}

#[tokio::test]
async fn configured_run_group_limit_rejects_excess_concurrency() {
    let mut config = ApplicationConfig::local_default();
    assert!(matches!(config.state.backend, StateBackendConfig::Turso(_)));
    config.workflows.max_concurrent_runs =
        NonZeroUsize::new(2).expect("test active run limit should be non-zero");
    let service = WorkflowService::with_config(config)
        .await
        .expect("configured state should build");
    let first = service
        .start(
            workflow_id(),
            json!({ "label": "first", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await
        .expect("first run should start");
    let second = service
        .start(
            workflow_id(),
            json!({ "label": "second", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await
        .expect("second run should start");
    let third = service
        .start(
            workflow_id(),
            json!({ "label": "third", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await;

    assert!(matches!(
        third,
        Err(WorkflowError::ActiveRunLimit { limit: 2 })
    ));
    assert_eq!(
        service
            .list_runs()
            .await
            .expect("run history should load")
            .into_iter()
            .map(|run| run.run_id)
            .collect::<Vec<_>>(),
        [first.run_id.clone(), second.run_id]
    );

    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if service
                .get_run(&first.run_id)
                .await
                .expect("run storage should load")
                .is_some_and(|run| matches!(run.status, RunStatus::Completed))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a completed run should release its execution-group slot");

    assert!(
        service
            .start(
                workflow_id(),
                json!({ "label": "after completion", "step_delay_ms": 350 }),
                RunTrigger::Manual,
            )
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn cron_attempt_at_the_active_run_limit_is_retained_as_failed() {
    let mut config = ApplicationConfig::local_default();
    config.workflows.max_concurrent_runs = NonZeroUsize::MIN;
    let service = WorkflowService::with_config(config)
        .await
        .expect("configured state should build");
    let mut events = service.subscribe();
    let _running = service
        .start(
            workflow_id(),
            json!({ "label": "occupies slot", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await
        .expect("one run should occupy the execution slot");

    let failed = service
        .trigger_schedule("demo-every-15-seconds-overlap")
        .await
        .expect("a rejected cron attempt should remain observable");

    assert!(matches!(
        failed.status,
        RunStatus::Failed { ref message } if message == "active workflow run limit reached: 1"
    ));
    assert!(failed.steps.is_empty());
    assert!(failed.finished_at.is_some());
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(
                events.recv().await,
                Ok(WorkflowEvent::RunFailed { run_id, .. }) if run_id == failed.run_id
            ) {
                break;
            }
        }
    })
    .await
    .expect("the failed cron attempt should emit a lifecycle event");
}

#[test]
fn execution_limits_default_from_the_workflow_topology() {
    let defaults = ApplicationConfig::local_default().workflows.execution;
    // Given: every registered workflow uses the application defaults.
    for definition in workflow_definitions() {
        // When: its effective execution limits are resolved.
        let limits = definition
            .execution_limits(&defaults)
            .expect("registered workflow limits should be valid");
        let expected_steps = definition.nodes.len() * defaults.step_multiplier.get();

        // Then: total and node limits use their independent constants.
        assert_eq!(limits.max_steps, expected_steps);
        assert_eq!(
            limits.timeout,
            defaults.timeout_per_step.get()
                * u32::try_from(expected_steps).expect("test workflow step count should fit u32")
        );
        assert_eq!(
            limits.node.max_executions,
            defaults.node.max_executions.get()
        );
        assert_eq!(limits.node.timeout, defaults.node.timeout.get());
    }
    assert_eq!(workflow_schedules().len(), 2);
}

#[tokio::test]
async fn every_code_defined_workflow_can_be_selected_and_completed() {
    let service = WorkflowService::new()
        .await
        .expect("every code-defined workflow should build");
    let definitions = workflow_definitions();
    let demo = definitions
        .iter()
        .find(|definition| definition.workflow_id == "demo-workflow")
        .expect("demo workflow is registered");
    let review = definitions
        .iter()
        .find(|definition| definition.workflow_id == "review-pipeline")
        .expect("review workflow is registered");
    let jcode = definitions
        .iter()
        .find(|definition| definition.workflow_id == "jcode-translation")
        .expect("jcode translation workflow is registered");

    assert_eq!(definitions.len(), 3);
    assert_ne!(demo.nodes, review.nodes);
    assert_ne!(review.nodes, jcode.nodes);

    let started = service
        .start(
            review.workflow_id,
            json!({ "subject": "release candidate", "reviewer": "local operator" }),
            RunTrigger::Manual,
        )
        .await
        .expect("the selected workflow starts");

    let terminal = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let snapshot = service
                .get_run(&started.run_id)
                .await
                .expect("run storage should load")
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
    assert_eq!(
        terminal.input.state(),
        &json!({ "subject": "release candidate", "reviewer": "local operator" })
    );
    assert_eq!(
        terminal.input.summary(),
        "release candidate · reviewer local operator"
    );
}

#[tokio::test]
async fn workflow_specific_input_rejects_another_workflows_fields() {
    let service = WorkflowService::new()
        .await
        .expect("every code-defined workflow should build");

    let result = service
        .start(
            "review-pipeline",
            json!({ "label": "wrong form", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await;

    assert!(matches!(result, Err(WorkflowError::InvalidInput { .. })));
    assert!(
        service
            .list_runs()
            .await
            .expect("run history should load")
            .is_empty()
    );
}

#[tokio::test]
async fn demo_input_rejects_label_longer_than_80_unicode_scalars_before_trim() {
    let service = WorkflowService::new()
        .await
        .expect("the code-defined workflow should build");
    let label = format!(" {} ", "界".repeat(80));

    let result = service
        .start(
            "demo-workflow",
            json!({ "label": label, "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await;

    assert!(matches!(result, Err(WorkflowError::InvalidInput { .. })));
}

#[tokio::test]
async fn review_input_rejects_subject_longer_than_80_unicode_scalars_before_trim() {
    let service = WorkflowService::new()
        .await
        .expect("the code-defined workflow should build");
    let subject = format!(" {} ", "界".repeat(80));

    let result = service
        .start(
            "review-pipeline",
            json!({ "subject": subject, "reviewer": "local operator" }),
            RunTrigger::Manual,
        )
        .await;

    assert!(matches!(result, Err(WorkflowError::InvalidInput { .. })));
}

#[tokio::test]
async fn jcode_translation_rejects_paths_outside_its_workspace() {
    let service = WorkflowService::new()
        .await
        .expect("every code-defined workflow should build");

    let result = service
        .start(
            "jcode-translation",
            json!({
                "source_path": "../Cargo.toml",
                "target_path": "output/cargo.ja.toml",
                "target_language": "Japanese"
            }),
            RunTrigger::Manual,
        )
        .await;

    assert!(matches!(result, Err(WorkflowError::InvalidInput { .. })));
    assert!(
        service
            .list_runs()
            .await
            .expect("run history should load")
            .is_empty()
    );
}
