use std::{
    num::NonZeroUsize,
    time::{Duration, SystemTime},
};

use graph_flow::{Session, SessionStorage};
use serde_json::json;

use super::{SqliteStore, sql};
use crate::{
    RunHistoryConfig, RunId, RunInput, RunRetention, RunSnapshot, RunStatus, RunTrigger,
    SqliteLocation, SqliteStateConfig, WorkflowError,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn config(capacity: usize) -> Result<SqliteStateConfig, Box<dyn std::error::Error>> {
    Ok(SqliteStateConfig {
        location: SqliteLocation::Memory,
        history: RunHistoryConfig {
            run_retention: RunRetention::KeepLatest(
                NonZeroUsize::new(capacity).ok_or("zero capacity")?,
            ),
        },
    })
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
    snapshot.finished_at = Some(SystemTime::UNIX_EPOCH);
    snapshot.duration = Some(Duration::ZERO);
}

async fn insert(store: &SqliteStore, id: &str) -> TestResult {
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
    let store = SqliteStore::open(&config(2)?).await?;
    let db = store.db.lock().await;
    let report = super::MIGRATIONS.apply(&db).await?;
    assert_eq!(report.applied(), 0);
    assert_eq!(report.skipped(), 1);
    drop(db);
    store.verify_schema().await?;
    Ok(())
}

#[tokio::test]
async fn session_round_trip_and_optimistic_locking() -> TestResult {
    let store = SqliteStore::open(&config(2)?).await?;
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
async fn retention_uses_completion_order_but_history_uses_start_order() -> TestResult {
    let store = SqliteStore::open(&config(1)?).await?;
    for id in ["first", "second", "active"] {
        insert(&store, id).await?;
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
    assert_eq!(ids, ["first", "active"]);
    assert!(store.get("second").await?.is_none());
    assert!(store.get("first").await?.is_some());
    assert!(store.get("active").await?.is_some());
    Ok(())
}

#[tokio::test]
async fn failed_completion_rolls_back_snapshot_lease_and_retention() -> TestResult {
    let store = SqliteStore::open(&config(1)?).await?;
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
        sql::statement("CREATE TRIGGER reject_eviction BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT, 'injected eviction failure'); END").exec(&mut *db).await?;
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
    let store = SqliteStore::open(&config(1)?).await?;
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
    let store = SqliteStore::open(&config(1)?).await?;
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
    let mut config = config(2)?;
    config.location = SqliteLocation::File(path.clone());
    {
        let store = SqliteStore::open(&config).await?;
        insert(&store, "retained").await?;
        store
            .mutate_run(&RunId("retained".to_owned()), complete)
            .await?;
        insert(&store, "interrupted").await?;
        assert!(store.claim_lease("stale").await?);
        assert!(matches!(
            SqliteStore::open(&config).await,
            Err(WorkflowError::Storage { .. })
        ));
    }
    {
        let store = SqliteStore::open(&config).await?;
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
        sql::statement("ALTER TABLE runs ADD COLUMN drift TEXT")
            .exec(&mut *db)
            .await?;
        drop(db);
    }
    assert!(matches!(
        SqliteStore::open(&config).await,
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
    let store = SqliteStore::open(&config(1)?).await?;
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
    let store = SqliteStore::open(&config(1)?).await?;
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
    let store = SqliteStore::open(&config(1)?).await?;
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
async fn startup_rejects_missing_or_rewound_ordering_clocks() -> TestResult {
    for corruption in [
        "DELETE FROM store_clocks WHERE id = 'start'",
        "DELETE FROM store_clocks WHERE id = 'terminal'",
        "UPDATE store_clocks SET value = 0 WHERE id = 'start'",
        "UPDATE store_clocks SET value = 0 WHERE id = 'terminal'",
    ] {
        let store = SqliteStore::open(&config(2)?).await?;
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
