use std::time::{Duration, SystemTime};

use graph_flow::{Session, SessionStorage};
use serde_json::json;

use super::{TursoStore, sql};
use crate::{
    RunId, RunInput, RunSnapshot, RunStatus, RunTrigger, TursoLocation, TursoStateConfig,
    WorkflowError,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn config() -> TursoStateConfig {
    TursoStateConfig {
        location: TursoLocation::Memory,
        remote: None,
    }
}

fn snapshot(id: &str) -> RunSnapshot {
    RunSnapshot {
        run_id: RunId(id.to_owned()),
        workflow_id: "demo".to_owned(),
        input: RunInput::new(json!({"choice":"left"}), "Left route".to_owned()),
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

fn complete(snapshot: &mut RunSnapshot) {
    snapshot.status = RunStatus::Completed;
    snapshot.finished_at = Some(snapshot.started_at);
    snapshot.duration = Some(Duration::ZERO);
}

async fn insert(store: &TursoStore, id: &str) -> TestResult {
    store
        .insert_run(
            snapshot(id),
            Some(Session::new_from_task(id.to_owned(), "start").with_graph_id("demo")),
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn migrations_are_repeatable_and_match_the_schema() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    let db = store.db.lock().await;
    let report = super::MIGRATIONS.apply(&db).await?;
    assert_eq!(report.applied(), 0);
    assert_eq!(report.skipped(), 1);
    drop(db);
    store.verify_schema().await?;
    Ok(())
}

#[tokio::test]
async fn committed_schema_rejects_invalid_rows_at_the_database_boundary() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    // Family conformance: every statement bypasses DTO validation and must be rejected by SQL.
    for statement in [
        "INSERT INTO graph_sessions VALUES ('zero-version', 0, '{}')",
        "INSERT INTO graph_sessions VALUES ('bad-json', 1, 'not-json')",
        "INSERT INTO runs VALUES ('negative-start', -1, NULL, 'running', '{}')",
        "INSERT INTO runs VALUES ('bad-status', 1, NULL, 'unknown', '{}')",
        "INSERT INTO runs VALUES ('terminal-without-finish', 1, NULL, 'completed', '{}')",
        "INSERT INTO schedule_leases VALUES ('   ')",
        "INSERT INTO runs VALUES ('negative-finish', 0, -1, 'completed', '{}')",
        "INSERT INTO runs VALUES ('running-with-finish', 0, 1, 'running', '{}')",
    ] {
        assert!(
            matches!(
                store.execute_test_sql(statement).await,
                Err(WorkflowError::Storage { .. })
            ),
            "database accepted invalid SQL: {statement}"
        );
    }
    // A rejected statement must not poison the pooled connection.
    insert(&store, "valid-after-rejections").await?;
    assert_eq!(store.history().await?.runs.len(), 1);
    Ok(())
}

#[tokio::test]
async fn independently_opened_memory_stores_do_not_share_state() -> TestResult {
    let first = TursoStore::open(&config()).await?;
    insert(&first, "private-run").await?;
    assert!(first.claim_lease("private-schedule").await?);

    let second = TursoStore::open(&config()).await?;
    assert!(second.history().await?.runs.is_empty());
    assert!(second.get("private-run").await?.is_none());
    assert!(second.claim_lease("private-schedule").await?);

    assert_eq!(first.history().await?.runs.len(), 1);
    assert!(first.get("private-run").await?.is_some());
    assert!(!first.claim_lease("private-schedule").await?);
    Ok(())
}

#[tokio::test]
async fn session_round_trip_and_optimistic_locking() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    let session = Session::new_from_task("session".to_owned(), "start");
    session.context.set(
        "nested",
        json!({"items":[null, true, {"unicode":"日本語"}]}),
    )?;
    store.save(session).await?;
    let session = store.get("session").await?.ok_or("missing session")?;
    assert_eq!(session.version, 1);
    assert_eq!(
        session.context.get::<serde_json::Value>("nested"),
        Some(json!({"items":[null, true, {"unicode":"日本語"}]}))
    );
    store.save(session.clone()).await?;
    assert!(matches!(
        store.save(session).await,
        Err(graph_flow::GraphError::SessionConflict(_))
    ));
    assert_eq!(
        store
            .get("session")
            .await?
            .ok_or("missing session")?
            .version,
        2
    );
    Ok(())
}

#[tokio::test]
async fn history_sorts_by_start_timestamp_despite_insertion_and_completion_order() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    for (id, millis) in [("active", 30), ("second", 20), ("first", 10)] {
        let mut run = snapshot(id);
        run.started_at += Duration::from_millis(millis);
        store
            .insert_run(run, Some(Session::new_from_task(id.to_owned(), "start")))
            .await?;
    }
    store
        .mutate_run(&RunId("second".to_owned()), complete)
        .await?;
    store
        .mutate_run(&RunId("first".to_owned()), complete)
        .await?;
    let ids: Vec<_> = store
        .history()
        .await?
        .runs
        .into_iter()
        .map(|run| run.run_id.to_string())
        .collect();
    assert_eq!(ids, ["first", "second", "active"]);
    assert!(store.get("second").await?.is_some());
    assert!(store.get("first").await?.is_some());
    assert!(store.get("active").await?.is_some());
    Ok(())
}

#[tokio::test]
async fn memory_history_keeps_more_than_one_hundred_terminal_runs_and_sessions() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    insert(&store, "active").await?;
    for index in 0..125 {
        let id = format!("completed-{index}");
        insert(&store, &id).await?;
        store.mutate_run(&RunId(id), complete).await?;
    }
    assert_eq!(store.history().await?.runs.len(), 126);
    assert_eq!(
        store
            .get_run(&RunId("active".to_owned()))
            .await?
            .ok_or("missing active run")?
            .status,
        RunStatus::Running
    );
    for index in 0..125 {
        let id = format!("completed-{index}");
        assert_eq!(
            store
                .get_run(&RunId(id.clone()))
                .await?
                .ok_or("missing completed run")?
                .status,
            RunStatus::Completed
        );
        assert!(store.get(&id).await?.is_some(), "missing session {id}");
    }
    Ok(())
}

#[tokio::test]
async fn reopening_file_keeps_more_than_one_hundred_terminal_runs_and_sessions() -> TestResult {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tmp")
        .join(format!("history-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let mut config = config();
    config.location = TursoLocation::File(directory.join("state.sqlite"));
    {
        let store = TursoStore::open(&config).await?;
        for index in 0..125 {
            let id = format!("completed-{index}");
            let mut run = snapshot(&id);
            complete(&mut run);
            store
                .insert_run(run, Some(Session::new_from_task(id, "start")))
                .await?;
        }
        insert(&store, "interrupted").await?;
        assert_eq!(store.history().await?.runs.len(), 126);
    }
    {
        let store = TursoStore::open(&config).await?;
        assert_eq!(store.history().await?.runs.len(), 126);
        for index in 0..125 {
            let id = format!("completed-{index}");
            assert_eq!(
                store
                    .get_run(&RunId(id.clone()))
                    .await?
                    .ok_or("missing completed run")?
                    .status,
                RunStatus::Completed
            );
            assert!(store.get(&id).await?.is_some(), "missing session {id}");
        }
        assert!(matches!(
            store
                .get_run(&RunId("interrupted".to_owned()))
                .await?
                .ok_or("missing interrupted run")?
                .status,
            RunStatus::Failed { .. }
        ));
        assert!(store.get("interrupted").await?.is_some());
    }
    std::fs::remove_dir_all(directory)?;
    Ok(())
}

#[tokio::test]
async fn failed_lease_release_rolls_back_completion_and_preserves_history() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    insert(&store, "old").await?;
    store.mutate_run(&RunId("old".to_owned()), complete).await?;
    let mut run = snapshot("new");
    run.trigger = RunTrigger::Cron {
        schedule_id: "schedule".to_owned(),
    };
    store
        .insert_run(run, Some(Session::new_from_task("new".to_owned(), "start")))
        .await?;
    assert!(store.claim_lease("schedule").await?);
    {
        let mut db = store.db.lock().await;
        sql::statement("CREATE TRIGGER reject_release BEFORE DELETE ON schedule_leases BEGIN SELECT RAISE(ABORT, 'injected lease release failure'); END").exec(&mut *db).await?;
        drop(db);
    }
    assert!(matches!(
        store.mutate_run(&RunId("new".to_owned()), complete).await,
        Err(WorkflowError::Storage { .. })
    ));
    assert_eq!(
        store
            .get_run(&RunId("new".to_owned()))
            .await?
            .ok_or("missing run")?
            .status,
        RunStatus::Running
    );
    assert!(!store.claim_lease("schedule").await?);
    assert!(store.get("old").await?.is_some());
    assert_eq!(store.history().await?.runs.len(), 2);
    Ok(())
}

#[tokio::test]
async fn failed_session_insert_does_not_leave_an_orphan_run() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    let mut session = Session::new_from_task("bad".to_owned(), "start");
    session.version = u64::MAX;
    assert!(matches!(
        store.insert_run(snapshot("bad"), Some(session)).await,
        Err(WorkflowError::Storage { .. })
    ));
    assert!(store.history().await?.runs.is_empty());
    Ok(())
}

#[tokio::test]
async fn schema_drift_and_corrupt_rows_are_errors() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    insert(&store, "one").await?;
    {
        let mut db = store.db.lock().await;
        sql::statement("UPDATE runs SET snapshot = '{}' WHERE id = 'one'")
            .exec(&mut *db)
            .await?;
        drop(db);
    }
    assert!(matches!(
        store.history().await,
        Err(WorkflowError::Storage { .. })
    ));
    {
        let mut db = store.db.lock().await;
        sql::statement("ALTER TABLE runs ADD COLUMN accidental TEXT")
            .exec(&mut *db)
            .await?;
        drop(db);
    }
    assert!(matches!(
        store.verify_schema().await,
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[tokio::test]
async fn reopening_file_recovers_interrupted_runs_and_preserves_sessions() -> TestResult {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tmp")
        .join(format!("sqlite-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("state.sqlite");
    let mut config = config();
    config.location = TursoLocation::File(path.clone());
    {
        let store = TursoStore::open(&config).await?;
        insert(&store, "retained").await?;
        store
            .mutate_run(&RunId("retained".to_owned()), complete)
            .await?;
        insert(&store, "interrupted").await?;
        assert!(store.claim_lease("stale").await?);
        assert!(matches!(
            TursoStore::open(&config).await,
            Err(WorkflowError::Storage { .. })
        ));
    }
    {
        let store = TursoStore::open(&config).await?;
        assert_eq!(store.history().await?.runs.len(), 2);
        assert!(matches!(
            store
                .get_run(&RunId("interrupted".to_owned()))
                .await?
                .ok_or("missing interrupted run")?
                .status,
            RunStatus::Failed { .. }
        ));
        assert!(store.get("retained").await?.is_some());
        assert!(store.claim_lease("stale").await?);
        let mut db = store.db.lock().await;
        let retained = super::models::RunRow::filter_by_id("retained")
            .get(&mut *db)
            .await?;
        assert_eq!((retained.started_at, retained.finished_at), (0, Some(0)));
        let recovered = super::models::RunRow::filter_by_id("interrupted")
            .get(&mut *db)
            .await?;
        let recovered_finish = recovered.finished_at.ok_or("missing recovery finish")?;
        assert_eq!(recovered.started_at, 0);
        let restored = recovered.into_snapshot()?;
        assert_eq!(
            restored.finished_at.map(super::epoch_millis).transpose()?,
            Some(recovered_finish)
        );
        sql::statement("ALTER TABLE runs ADD COLUMN drift TEXT")
            .exec(&mut *db)
            .await?;
        drop(db);
    }
    assert!(matches!(
        TursoStore::open(&config).await,
        Err(WorkflowError::Storage { .. })
    ));
    std::fs::remove_dir_all(directory)?;
    Ok(())
}

#[tokio::test]
async fn failed_migration_rolls_back_ddl_and_preserves_existing_rows() -> TestResult {
    use toasty::migration::{MigrationFile, MigrationSet};
    const INVALID: MigrationSet = MigrationSet::new(&[MigrationFile::new(
        2,
        "0002_invalid.sql",
        "CREATE TABLE migration_probe (id TEXT PRIMARY KEY);\n-- #[toasty::breakpoint]\nINSERT INTO missing_table VALUES (1);",
    )]);
    let store = TursoStore::open(&config()).await?;
    insert(&store, "kept").await?;
    let mut db = store.db.lock().await;
    assert!(INVALID.apply(&db).await.is_err());
    let tables = sql::query("SELECT name FROM sqlite_schema WHERE name = 'migration_probe'")
        .exec(&mut *db)
        .await?;
    assert!(tables.is_empty());
    super::verify_migration_history(&mut db).await?;
    drop(db);
    assert!(store.get_run(&RunId("kept".to_owned())).await?.is_some());
    Ok(())
}

#[tokio::test]
async fn unknown_migration_and_invalid_lease_are_rejected() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    assert!(matches!(
        store.claim_lease(" \t\n").await,
        Err(WorkflowError::Storage { .. })
    ));
    let mut db = store.db.lock().await;
    sql::statement("INSERT INTO __toasty_migrations (id, name, applied_at) VALUES (99, 'future.sql', datetime('now'))").exec(&mut *db).await?;
    assert!(matches!(
        super::verify_migration_history(&mut db).await,
        Err(WorkflowError::Storage { .. })
    ));
    drop(db);
    Ok(())
}

#[tokio::test]
async fn concurrent_claims_and_session_saves_have_exactly_one_winner() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    let (first, second) = tokio::join!(store.claim_lease("race"), store.claim_lease("race"));
    assert_ne!(first?, second?);
    store
        .save(Session::new_from_task("race".to_owned(), "start"))
        .await?;
    let session = store.get("race").await?.ok_or("missing race session")?;
    let (first, second) = tokio::join!(store.save(session.clone()), store.save(session));
    assert!(matches!(
        (first, second),
        (Ok(()), Err(graph_flow::GraphError::SessionConflict(_)))
            | (Err(graph_flow::GraphError::SessionConflict(_)), Ok(()))
    ));
    assert_eq!(
        store
            .get("race")
            .await?
            .ok_or("missing race session")?
            .version,
        2
    );
    Ok(())
}

#[test]
fn schema_comparison_preserves_meaningful_quoted_whitespace() {
    assert_eq!(
        super::normalize_schema("CREATE TABLE t (id TEXT);"),
        super::normalize_schema("CREATE  TABLE t ( id TEXT )")
    );
    assert_ne!(
        super::normalize_schema("CHECK (status = 'running')"),
        super::normalize_schema("CHECK (status = 'run ning')")
    );
}

#[tokio::test]
async fn startup_rejects_timestamp_metadata_disagreement_before_recovery() -> TestResult {
    // Family conformance: either timestamp column must agree with its snapshot.
    for corruption in [
        "UPDATE runs SET started_at = 1 WHERE id = 'terminal'",
        "UPDATE runs SET finished_at = 1 WHERE id = 'terminal'",
    ] {
        let store = TursoStore::open(&config()).await?;
        insert(&store, "terminal").await?;
        store
            .mutate_run(&RunId("terminal".to_owned()), complete)
            .await?;
        insert(&store, "still-active").await?;
        store.execute_test_sql(corruption).await?;
        assert!(matches!(
            store.recover().await,
            Err(WorkflowError::Storage { .. })
        ));
        assert_eq!(
            store
                .get_run(&RunId("still-active".to_owned()))
                .await?
                .ok_or("missing active run")?
                .status,
            RunStatus::Running
        );
    }
    Ok(())
}

#[tokio::test]
async fn equal_start_milliseconds_are_sorted_by_id_not_insertion_or_submillisecond_time()
-> TestResult {
    let store = TursoStore::open(&config()).await?;
    for (id, nanos) in [("z", 1), ("a", 999_999), ("m", 500_000)] {
        let mut run = snapshot(id);
        run.started_at += Duration::from_nanos(nanos);
        store.insert_run(run, None).await?;
    }
    let ids: Vec<_> = store
        .history()
        .await?
        .runs
        .into_iter()
        .map(|run| run.run_id.to_string())
        .collect();
    assert_eq!(ids, ["a", "m", "z"]);
    Ok(())
}

#[tokio::test]
async fn run_timestamp_columns_follow_snapshot_times_without_losing_snapshot_precision()
-> TestResult {
    let store = TursoStore::open(&config()).await?;
    let mut run = snapshot("timed");
    run.started_at += Duration::from_nanos(1_234_567_890);
    let started = run.started_at;
    store.insert_run(run, None).await?;
    {
        let mut db = store.db.lock().await;
        let row = super::models::RunRow::filter_by_id("timed")
            .get(&mut *db)
            .await?;
        drop(db);
        assert_eq!((row.started_at, row.finished_at), (1234, None));
        let restored = row.into_snapshot()?;
        assert_eq!((restored.started_at, restored.finished_at), (started, None));
    }
    let elapsed = Duration::from_nanos(9_876_543_210);
    let finished = started + elapsed;
    store
        .mutate_run(&RunId("timed".to_owned()), |run| {
            run.status = RunStatus::Completed;
            run.finished_at = Some(finished);
            run.duration = Some(elapsed);
        })
        .await?;
    let mut db = store.db.lock().await;
    let row = super::models::RunRow::filter_by_id("timed")
        .get(&mut *db)
        .await?;
    drop(db);
    assert_eq!((row.started_at, row.finished_at), (1234, Some(11111)));
    let restored = row.into_snapshot()?;
    assert_eq!(
        (restored.started_at, restored.finished_at, restored.duration),
        (started, Some(finished), Some(elapsed))
    );
    Ok(())
}

#[tokio::test]
async fn running_mutation_preserves_optional_finish_timestamp() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    insert(&store, "running").await?;
    store
        .mutate_run(&RunId("running".to_owned()), |run| {
            run.route_summary = "still running".to_owned();
        })
        .await?;
    let mut db = store.db.lock().await;
    let row = super::models::RunRow::filter_by_id("running")
        .get(&mut *db)
        .await?;
    drop(db);
    assert_eq!((row.started_at, row.finished_at), (0, None));
    let restored = row.into_snapshot()?;
    assert_eq!(restored.route_summary, "still running");
    assert_eq!(restored.status, RunStatus::Running);
    Ok(())
}

#[tokio::test]
async fn terminal_insert_preserves_independent_start_and_finish_times() -> TestResult {
    let store = TursoStore::open(&config()).await?;
    let mut run = snapshot("terminal");
    run.started_at += Duration::from_secs(2);
    run.finished_at = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(5));
    run.duration = Some(Duration::from_secs(3));
    run.status = RunStatus::Completed;
    store.insert_run(run, None).await?;
    let mut db = store.db.lock().await;
    let row = super::models::RunRow::filter_by_id("terminal")
        .get(&mut *db)
        .await?;
    drop(db);
    assert_eq!((row.started_at, row.finished_at), (2000, Some(5000)));
    assert_eq!(row.into_snapshot()?.status, RunStatus::Completed);
    Ok(())
}

#[tokio::test]
async fn replication_failure_does_not_orphan_local_runs_or_leases() -> TestResult {
    let mut store = TursoStore::open(&config()).await?;
    // Fault injection at the driver boundary: invalid remote setup must fail to push.
    // This does not claim successful Cloud synchronization.
    store.remote = Some(toasty_driver_turso::Turso::in_memory().with_remote_url("invalid-url"));
    assert!(store.flush_remote().await.is_err());
    assert!(store.claim_lease("locally-owned").await?);
    insert(&store, "locally-created").await?;
    assert!(
        store
            .get_run(&RunId("locally-created".to_owned()))
            .await?
            .is_some()
    );
    store
        .mutate_run(&RunId("locally-created".to_owned()), complete)
        .await?;
    store.release_lease("locally-owned").await?;
    assert!(store.claim_lease("locally-owned").await?);
    assert_eq!(store.history().await?.runs.len(), 1);
    assert!(store.flush_remote().await.is_err());
    Ok(())
}

#[tokio::test]
async fn local_only_service_flush_is_a_successful_noop() -> TestResult {
    let service =
        crate::WorkflowService::with_config(crate::ApplicationConfig::local_default()).await?;
    service.flush_storage().await?;
    Ok(())
}

#[tokio::test]
async fn run_status_enum_round_trips_all_variants_through_the_database() -> TestResult {
    use super::models::RunStatusRow;

    let store = TursoStore::open(&config()).await?;
    // Family conformance: every domain status maps to the same SQL label and ORM variant.
    for (id, status, expected) in [
        ("running", RunStatus::Running, RunStatusRow::Running),
        ("completed", RunStatus::Completed, RunStatusRow::Completed),
        (
            "failed",
            RunStatus::Failed {
                message: "failure".to_owned(),
            },
            RunStatusRow::Failed,
        ),
        (
            "skipped",
            RunStatus::Skipped {
                reason: "overlap".to_owned(),
            },
            RunStatusRow::Skipped,
        ),
    ] {
        let mut run = snapshot(id);
        if status != RunStatus::Running {
            complete(&mut run);
        }
        run.status = status.clone();
        store.insert_run(run, None).await?;
        let mut db = store.db.lock().await;
        let row = super::models::RunRow::filter_by_id(id)
            .get(&mut *db)
            .await?;
        let labels = sql::query("SELECT status FROM runs WHERE id = ?1")
            .bind(id)
            .exec(&mut *db)
            .await?;
        drop(db);
        assert_eq!(row.status, expected);
        assert_eq!(row.into_snapshot()?.status, status);
        let [toasty::stmt::Value::Record(label)] = labels.as_slice() else {
            return Err("missing status label".into());
        };
        assert_eq!(&**label, &[toasty::stmt::Value::String(id.to_owned())]);
    }
    Ok(())
}
