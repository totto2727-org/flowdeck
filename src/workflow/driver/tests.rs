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

async fn fault_fixture() -> Result<
    (
        super::Inner,
        std::sync::Arc<crate::storage::SqliteStore>,
        tokio::sync::broadcast::Receiver<crate::WorkflowEvent>,
    ),
    Box<dyn std::error::Error>,
> {
    use super::super::{ActiveRunGroup, ApplicationState, WorkflowTasks};
    use std::{collections::HashMap, sync::Arc};
    let config = crate::ApplicationConfig::local_default();
    let crate::StateBackendConfig::Sqlite(state_config) = &config.state.backend;
    let store = Arc::new(crate::storage::SqliteStore::open(state_config).await?);
    let (events, receiver) = tokio::sync::broadcast::channel(4);
    let inner = super::Inner {
        runtimes: HashMap::new(),
        state: ApplicationState {
            graph_sessions: Arc::<crate::storage::SqliteStore>::clone(&store),
            run_history: Arc::<crate::storage::SqliteStore>::clone(&store),
            schedule_leases: Arc::<crate::storage::SqliteStore>::clone(&store),
        },
        scheduler: config.scheduler,
        run_group: ActiveRunGroup::new(config.workflows.max_concurrent_runs),
        events,
        tasks: WorkflowTasks::new(Arc::new(crate::ResourceStore::new())),
    };
    let mut run = snapshot();
    run.trigger = RunTrigger::Cron {
        schedule_id: "fault-schedule".to_owned(),
    };
    let _ = run.begin_step("loop");
    store
        .insert_run(
            run,
            Some(graph_flow::Session::new_from_task(
                "limit-test".to_owned(),
                "loop",
            )),
        )
        .await?;
    assert!(store.claim_lease("fault-schedule").await?);
    Ok((inner, store, receiver))
}

#[tokio::test]
async fn transient_storage_failure_is_committed_before_terminal_event()
-> Result<(), Box<dyn std::error::Error>> {
    let (inner, store, mut events) = fault_fixture().await?;
    store.execute_test_sql("CREATE TRIGGER reject_completion BEFORE UPDATE ON runs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END").await?;
    let run_id = RunId("limit-test".to_owned());
    let result = store
        .mutate_run(&run_id, |run| {
            run.status = RunStatus::Completed;
        })
        .await;
    let Err(error @ crate::WorkflowError::Storage { .. }) = result else {
        return Err("expected injected storage error".into());
    };
    super::recover_storage_failure(&inner, &run_id, &error).await?;
    let run = store
        .get_run(&run_id)
        .await?
        .ok_or("missing recovered run")?;
    assert!(matches!(run.status, RunStatus::Failed { .. }));
    assert!(matches!(
        run.steps.first().map(|step| &step.status),
        Some(crate::StepTraceStatus::Failed { .. })
    ));
    assert!(store.claim_lease("fault-schedule").await?);
    assert!(matches!(
        events.try_recv()?,
        crate::WorkflowEvent::RunFailed { .. }
    ));
    Ok(())
}

#[tokio::test]
async fn unrecoverable_storage_failure_does_not_publish_a_false_terminal_event()
-> Result<(), Box<dyn std::error::Error>> {
    let (inner, store, mut events) = fault_fixture().await?;
    store.execute_test_sql("CREATE TRIGGER reject_updates BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'injected persistent failure'); END").await?;
    let run_id = RunId("limit-test".to_owned());
    let error = crate::WorkflowError::Storage {
        message: "initial storage failure".to_owned(),
    };
    assert!(matches!(
        super::recover_storage_failure(&inner, &run_id, &error).await,
        Err(crate::WorkflowError::Storage { .. })
    ));
    assert_eq!(
        store
            .get_run(&run_id)
            .await?
            .ok_or("missing active run")?
            .status,
        RunStatus::Running
    );
    assert!(!store.claim_lease("fault-schedule").await?);
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    Ok(())
}
