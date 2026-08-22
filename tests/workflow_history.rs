//! Integration coverage for the local workflow execution boundary.

use std::{num::NonZeroUsize, time::Duration};

use serde_json::json;
use workflow_console_experiment::{
    ApplicationConfig, HistoryReplay, HistoryRevision, RunStatus, RunTrigger,
    ScheduleOverlapPolicy, SchedulerMode, StateBackendConfig, StepTraceStatus, WorkflowError,
    WorkflowService, workflow_definitions, workflow_id, workflow_schedules,
};

#[tokio::test]
async fn history_delta_when_run_starts_contains_atomic_before_and_after() {
    // Given: a history subscriber attached before the first mutation.
    let service = WorkflowService::new().expect("the code-defined workflow should build");
    let mut deltas = service.subscribe_history();

    // When: a valid workflow starts.
    let started = service
        .start(
            "review-pipeline",
            json!({ "subject": "history delta", "reviewer": "local operator" }),
            RunTrigger::Manual,
        )
        .await
        .expect("the workflow should start");
    let delta = deltas
        .recv()
        .await
        .expect("the start delta should be published");

    // Then: the first revision describes the insertion without a partial snapshot.
    assert_eq!(delta.revision, HistoryRevision::new(1));
    assert_eq!(delta.run_id, started.run_id);
    assert!(delta.before.is_none());
    assert_eq!(
        delta.after.as_ref().map(|run| &run.run_id),
        Some(&started.run_id)
    );
}

#[tokio::test]
async fn history_replay_when_current_or_future_revision_is_requested() {
    // Given: one retained start mutation and its revisioned view.
    let service = WorkflowService::new().expect("the code-defined workflow should build");
    service
        .start(
            "review-pipeline",
            json!({ "subject": "history replay", "reviewer": "local operator" }),
            RunTrigger::Manual,
        )
        .await
        .expect("the workflow should start");
    let view = service.history_view().await;

    // When: replay is requested from the current and a future revision.
    let current = service.history_since(view.revision).await;
    let future = service
        .history_since(HistoryRevision::new(
            view.revision.value().saturating_add(1),
        ))
        .await;

    // Then: current is empty while a future cursor is stale.
    assert!(matches!(current, HistoryReplay::Changes(changes) if changes.is_empty()));
    assert!(matches!(future, HistoryReplay::Stale { current } if current == view.revision));
}

#[tokio::test]
async fn history_replay_when_mutations_follow_cursor_is_ordered() {
    // Given: a subscriber is established before reading the empty revision.
    let service = WorkflowService::new().expect("the code-defined workflow should build");
    let mut subscriber = service.subscribe_history();
    let cursor = service.history_view().await.revision;

    // When: one linear run is inserted and reaches its terminal state.
    let started = service
        .start(
            "review-pipeline",
            json!({ "subject": "ordered replay", "reviewer": "local operator" }),
            RunTrigger::Manual,
        )
        .await
        .expect("the workflow should start");
    let mut observed = Vec::new();
    for _ in 0..9 {
        observed.push(
            tokio::time::timeout(Duration::from_secs(3), subscriber.recv())
                .await
                .expect("each history mutation should arrive")
                .expect("the history subscriber should not lag"),
        );
    }
    let replay = service.history_since(cursor).await;

    // Then: start and every step mutation increment once in strict order.
    assert_eq!(observed.len(), 9);
    assert_eq!(
        observed
            .iter()
            .map(|delta| delta.revision.value())
            .collect::<Vec<_>>(),
        (1..=9).collect::<Vec<_>>()
    );
    let terminal = observed.last().expect("the terminal delta should exist");
    assert_eq!(terminal.run_id, started.run_id);
    assert!(matches!(
        terminal.before.as_ref().map(|run| &run.status),
        Some(RunStatus::Running)
    ));
    assert!(matches!(
        terminal.after.as_ref().map(|run| &run.status),
        Some(RunStatus::Completed)
    ));
    let changes = match replay {
        HistoryReplay::Changes(changes) => changes,
        HistoryReplay::Stale { .. } => panic!("a retained cursor should be replayable"),
    };
    assert_eq!(changes.len(), 9);
    assert_eq!(
        changes.first().map(|delta| delta.revision),
        Some(HistoryRevision::new(1))
    );
    assert!(
        changes.windows(2).all(
            |pair| matches!(pair, [previous, current] if previous.revision < current.revision)
        )
    );
}

#[tokio::test]
async fn workflow_history_when_duplicate_or_malformed_request() {
    let service = WorkflowService::new().expect("the code-defined workflow should build");

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
    let service = WorkflowService::new().expect("the code-defined workflow should build");
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
    let service = WorkflowService::new().expect("the code-defined workflow should build");

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
    let service = WorkflowService::new().expect("the code-defined workflow should build");
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
    assert_eq!(service.list_runs().await.len(), 2);
}

#[tokio::test]
async fn cron_schedule_allows_overlap_when_configured() {
    // Given: a schedule explicitly configured to allow overlap.
    let service = WorkflowService::new().expect("the code-defined workflow should build");

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
    let service = WorkflowService::with_config(config).expect("configured workflows should build");

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
    let service = WorkflowService::with_config(config).expect("disabled scheduler should build");

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
async fn configured_history_replay_capacity_controls_stale_boundary() {
    let mut config = ApplicationConfig::local_default();
    assert!(matches!(
        config.state.backend,
        StateBackendConfig::InMemory(_)
    ));
    let StateBackendConfig::InMemory(memory) = &mut config.state.backend;
    memory.history.replay_capacity =
        NonZeroUsize::new(2).expect("test replay capacity should be non-zero");
    let service = WorkflowService::with_config(config).expect("configured state should build");
    let started = service
        .start(
            "review-pipeline",
            json!({ "subject": "bounded replay", "reviewer": "operator" }),
            RunTrigger::Manual,
        )
        .await
        .expect("review run should start");

    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let snapshot = service
                .get_run(&started.run_id)
                .await
                .expect("run should remain retained");
            if matches!(snapshot.status, RunStatus::Completed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("review run should complete");

    assert!(matches!(
        service.history_since(HistoryRevision::new(0)).await,
        HistoryReplay::Stale { .. }
    ));
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
    let service = WorkflowService::new().expect("every code-defined workflow should build");

    let result = service
        .start(
            "review-pipeline",
            json!({ "label": "wrong form", "step_delay_ms": 350 }),
            RunTrigger::Manual,
        )
        .await;

    assert!(matches!(result, Err(WorkflowError::InvalidInput { .. })));
    assert!(service.list_runs().await.is_empty());
}

#[tokio::test]
async fn demo_input_rejects_label_longer_than_80_unicode_scalars_before_trim() {
    let service = WorkflowService::new().expect("the code-defined workflow should build");
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
    let service = WorkflowService::new().expect("the code-defined workflow should build");
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
    let service = WorkflowService::new().expect("every code-defined workflow should build");

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
    assert!(service.list_runs().await.is_empty());
}
