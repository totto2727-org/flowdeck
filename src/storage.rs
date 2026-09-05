//! `SQLite` persistence for workflow snapshots, graph sessions, and schedule leases.

use std::{
    fs::{File, OpenOptions},
    time::SystemTime,
};

use async_trait::async_trait;
use garde::Validate;
use graph_flow::{GraphError, Session, SessionStorage};
use toasty::{
    Db, Executor,
    migration::{MigrationFile, MigrationSet},
    sql,
};
use tokio::sync::Mutex;

use crate::{
    HistoryView, RunId, RunRetention, RunSnapshot, RunStatus, RunTrigger, SqliteLocation,
    SqliteStateConfig, WorkflowError,
};

mod models;
mod run_dto;
mod session_dto;
use models::{ClockRow, LeaseRow, MigrationRow, RunRow, SessionRow};

const INITIAL_SQL: &str = include_str!("storage/migrations/0001_initial.sql");
const CURRENT_SCHEMA: &str = include_str!("storage/schema.sql");
const MIGRATIONS: MigrationSet =
    MigrationSet::new(&[MigrationFile::new(1, "0001_initial.sql", INITIAL_SQL)]);

#[allow(
    clippy::redundant_pub_crate,
    reason = "The live database store is intentionally crate-internal, not application public API."
)]
pub(crate) struct SqliteStore {
    db: Mutex<Db>,
    terminal_capacity: i64,
    // A file service owns its database exclusively, so startup recovery cannot interrupt another service.
    _file_lock: Option<File>,
}

impl SqliteStore {
    #[cfg(test)]
    pub(crate) async fn execute_test_sql(&self, statement: &str) -> Result<(), WorkflowError> {
        let mut db = self.db.lock().await;
        sql::statement(statement)
            .exec(&mut *db)
            .await
            .map_err(error)?;
        drop(db);
        Ok(())
    }

    pub(crate) async fn open(config: &SqliteStateConfig) -> Result<Self, WorkflowError> {
        let (url, file_lock) = match &config.location {
            SqliteLocation::Memory => ("sqlite::memory:".to_owned(), None),
            SqliteLocation::File(path) => {
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(path)
                    .map_err(error)?;
                drop(file);
                let path = path.canonicalize().map_err(error)?;
                let mut lock_path = path.as_os_str().to_os_string();
                lock_path.push(".flowdeck-lock");
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(std::path::PathBuf::from(lock_path))
                    .map_err(error)?;
                file.try_lock().map_err(error)?;
                let path = path
                    .to_str()
                    .ok_or_else(|| error("SQLite path must be valid UTF-8"))?;
                (format!("sqlite:{path}"), Some(file))
            }
        };
        let mut db = Db::builder()
            .models(toasty::models!(
                RunRow,
                SessionRow,
                LeaseRow,
                ClockRow,
                MigrationRow
            ))
            .max_pool_size(1)
            .pool_max_connection_lifetime(None)
            .pool_max_connection_idle_time(None)
            .connect(&url)
            .await
            .map_err(error)?;
        verify_migration_history(&mut db).await?;
        MIGRATIONS.apply(&db).await.map_err(error)?;
        let RunRetention::KeepLatest(capacity) = config.history.run_retention;
        let store = Self {
            db: Mutex::new(db),
            terminal_capacity: i64::try_from(capacity.get()).map_err(error)?,
            _file_lock: file_lock,
        };
        store.verify_schema().await?;
        store.recover().await?;
        Ok(store)
    }

    async fn verify_schema(&self) -> Result<(), WorkflowError> {
        let mut db = self.db.lock().await;
        for statement in CURRENT_SCHEMA
            .split("-- #[toasty::breakpoint]")
            .map(str::trim)
            .filter(|s| s.starts_with("CREATE TABLE"))
        {
            let name = statement
                .split_whitespace()
                .nth(2)
                .ok_or_else(|| error("invalid embedded schema"))?;
            let rows =
                sql::query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?1")
                    .bind(name)
                    .exec(&mut *db)
                    .await
                    .map_err(error)?;
            let [toasty::stmt::Value::Record(row)] = rows.as_slice() else {
                return Err(error(format!("missing SQLite table {name}")));
            };
            let [toasty::stmt::Value::String(actual)] = &**row else {
                return Err(error("invalid SQLite schema metadata"));
            };
            if normalize_schema(actual) != normalize_schema(statement) {
                return Err(error(format!(
                    "SQLite schema drift detected for table {name}"
                )));
            }
        }
        drop(db);
        Ok(())
    }

    #[allow(
        clippy::significant_drop_tightening,
        reason = "The database guard is borrowed for the entire atomic Toasty transaction."
    )]
    pub(crate) async fn insert_run(
        &self,
        snapshot: RunSnapshot,
        session: Option<Session>,
    ) -> Result<(), WorkflowError> {
        let mut db = self.db.lock().await;
        let mut tx = db.transaction().await.map_err(error)?;
        let start = next_order(&mut tx, "start").await?;
        let terminal = snapshot.status != RunStatus::Running;
        let terminal_order = if terminal {
            Some(next_order(&mut tx, "terminal").await?)
        } else {
            None
        };
        let json = run_dto::encode(&snapshot)?;
        let row = RunRow {
            id: snapshot.run_id.to_string(),
            start_order: start,
            terminal_order,
            status: status_name(&snapshot.status).to_owned(),
            snapshot: json,
        };
        row.validate().map_err(error)?;
        RunRow::create()
            .id(row.id)
            .start_order(row.start_order)
            .terminal_order(row.terminal_order)
            .status(row.status)
            .snapshot(row.snapshot)
            .exec(&mut tx)
            .await
            .map_err(error)?;
        if let Some(session) = session {
            save_session(&mut tx, session).await.map_err(error)?;
        }
        retain(&mut tx, self.terminal_capacity).await?;
        tx.commit().await.map_err(error)
    }

    pub(crate) async fn get_run(&self, id: &RunId) -> Result<Option<RunSnapshot>, WorkflowError> {
        let mut db = self.db.lock().await;
        RunRow::filter_by_id(id.as_str())
            .first()
            .exec(&mut *db)
            .await
            .map_err(error)?
            .map(RunRow::into_snapshot)
            .transpose()
    }

    pub(crate) async fn history(&self) -> Result<HistoryView, WorkflowError> {
        let mut db = self.db.lock().await;
        let mut rows = RunRow::all().exec(&mut *db).await.map_err(error)?;
        drop(db);
        rows.sort_by_key(|row| row.start_order);
        Ok(HistoryView {
            runs: rows
                .into_iter()
                .map(RunRow::into_snapshot)
                .collect::<Result<_, _>>()?,
        })
    }

    #[allow(
        clippy::significant_drop_tightening,
        reason = "The database guard is borrowed for the entire atomic Toasty transaction."
    )]
    pub(crate) async fn mutate_run<R: Send>(
        &self,
        id: &RunId,
        mutation: impl FnOnce(&mut RunSnapshot) -> R + Send,
    ) -> Result<Option<R>, WorkflowError> {
        let mut db = self.db.lock().await;
        let mut tx = db.transaction().await.map_err(error)?;
        let Some(row) = RunRow::filter_by_id(id.as_str())
            .first()
            .exec(&mut tx)
            .await
            .map_err(error)?
        else {
            tx.commit().await.map_err(error)?;
            return Ok(None);
        };
        let mut snapshot = row.into_snapshot()?;
        if snapshot.status != RunStatus::Running {
            tx.commit().await.map_err(error)?;
            return Ok(None);
        }
        let result = mutation(&mut snapshot);
        persist_mutation(&mut tx, &snapshot).await?;
        retain(&mut tx, self.terminal_capacity).await?;
        tx.commit().await.map_err(error)?;
        Ok(Some(result))
    }

    pub(crate) async fn claim_lease(&self, id: &str) -> Result<bool, WorkflowError> {
        LeaseRow { id: id.to_owned() }.validate().map_err(error)?;
        let mut db = self.db.lock().await;
        let count = sql::statement(
            "INSERT INTO schedule_leases (id) VALUES (?1) ON CONFLICT(id) DO NOTHING",
        )
        .bind(id)
        .exec(&mut *db)
        .await
        .map_err(error)?;
        drop(db);
        Ok(count == 1)
    }

    pub(crate) async fn release_lease(&self, id: &str) -> Result<(), WorkflowError> {
        let mut db = self.db.lock().await;
        sql::statement("DELETE FROM schedule_leases WHERE id = ?1")
            .bind(id)
            .exec(&mut *db)
            .await
            .map_err(error)?;
        drop(db);
        Ok(())
    }

    #[allow(
        clippy::significant_drop_tightening,
        reason = "The database guard is borrowed for the entire atomic Toasty transaction."
    )]
    async fn recover(&self) -> Result<(), WorkflowError> {
        let mut db = self.db.lock().await;
        let mut tx = db.transaction().await.map_err(error)?;
        // Validate every stored boundary before performing any recovery mutation.
        let rows = RunRow::all().exec(&mut tx).await.map_err(error)?;
        verify_clocks(&mut tx, &rows).await?;
        let snapshots = rows
            .into_iter()
            .map(RunRow::into_snapshot)
            .collect::<Result<Vec<_>, _>>()?;
        for row in SessionRow::all().exec(&mut tx).await.map_err(error)? {
            row.into_session()?;
        }
        for row in LeaseRow::all().exec(&mut tx).await.map_err(error)? {
            row.validate().map_err(error)?;
        }
        for mut snapshot in snapshots
            .into_iter()
            .filter(|snapshot| snapshot.status == RunStatus::Running)
        {
            let finished = SystemTime::now();
            let message = "workflow interrupted by service restart".to_owned();
            let step = snapshot
                .steps
                .iter()
                .rev()
                .find(|step| step.status == crate::StepTraceStatus::Running)
                .map(|step| step.step_id);
            snapshot.fail_step(step, &message, finished);
            snapshot.finished_at = Some(finished);
            snapshot.duration = finished.duration_since(snapshot.started_at).ok();
            snapshot.status = RunStatus::Failed { message };
            persist_mutation(&mut tx, &snapshot).await?;
        }
        sql::statement("DELETE FROM schedule_leases")
            .exec(&mut tx)
            .await
            .map_err(error)?;
        retain(&mut tx, self.terminal_capacity).await?;
        tx.commit().await.map_err(error)
    }
}

async fn next_order(executor: &mut dyn Executor, id: &str) -> Result<i64, WorkflowError> {
    let count = sql::statement(
        "UPDATE store_clocks SET value = value + 1 WHERE id = ?1 AND value < 9223372036854775807",
    )
    .bind(id)
    .exec(executor)
    .await
    .map_err(error)?;
    if count != 1 {
        return Err(error("storage ordering counter missing or exhausted"));
    }
    let row = ClockRow::filter_by_id(id)
        .get(executor)
        .await
        .map_err(error)?;
    row.validate().map_err(error)?;
    Ok(row.value)
}

async fn persist_mutation(
    executor: &mut dyn Executor,
    snapshot: &RunSnapshot,
) -> Result<(), WorkflowError> {
    let json = run_dto::encode(snapshot)?;
    if snapshot.status == RunStatus::Running {
        sql::statement("UPDATE runs SET snapshot = ?1 WHERE id = ?2")
            .bind(json)
            .bind(snapshot.run_id.as_str())
            .exec(executor)
            .await
            .map_err(error)?;
    } else {
        let order = next_order(executor, "terminal").await?;
        sql::statement(
            "UPDATE runs SET snapshot = ?1, status = ?2, terminal_order = ?3 WHERE id = ?4",
        )
        .bind(json)
        .bind(status_name(&snapshot.status))
        .bind(order)
        .bind(snapshot.run_id.as_str())
        .exec(executor)
        .await
        .map_err(error)?;
        if let RunTrigger::Cron { schedule_id } = &snapshot.trigger {
            sql::statement("DELETE FROM schedule_leases WHERE id = ?1")
                .bind(schedule_id.as_str())
                .exec(executor)
                .await
                .map_err(error)?;
        }
    }
    Ok(())
}

async fn retain(executor: &mut dyn Executor, capacity: i64) -> Result<(), WorkflowError> {
    sql::statement("DELETE FROM graph_sessions WHERE id IN (SELECT id FROM runs WHERE terminal_order IS NOT NULL ORDER BY terminal_order DESC LIMIT -1 OFFSET ?1)").bind(capacity).exec(executor).await.map_err(error)?;
    sql::statement("DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE terminal_order IS NOT NULL ORDER BY terminal_order DESC LIMIT -1 OFFSET ?1)").bind(capacity).exec(executor).await.map_err(error)?;
    Ok(())
}

async fn save_session(executor: &mut dyn Executor, mut session: Session) -> Result<(), GraphError> {
    let previous = i64::try_from(session.version).map_err(graph_error)?;
    session.version = session
        .version
        .checked_add(1)
        .ok_or_else(|| GraphError::StorageError("session version exhausted".to_owned()))?;
    let version = i64::try_from(session.version).map_err(graph_error)?;
    let row = SessionRow {
        id: session.id,
        version,
        payload: String::new(),
    };
    session.id = row.id.clone();
    let row = SessionRow {
        payload: session_dto::encode(&session).map_err(graph_error)?,
        ..row
    };
    row.validate().map_err(graph_error)?;
    let count = sql::statement("INSERT INTO graph_sessions (id, version, payload) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload = excluded.payload WHERE graph_sessions.version = ?4").bind(row.id.as_str()).bind(row.version).bind(row.payload).bind(previous).exec(executor).await.map_err(graph_error)?;
    if count == 0 {
        return Err(GraphError::SessionConflict(format!(
            "session {} was modified concurrently",
            row.id
        )));
    }
    Ok(())
}

#[async_trait]
impl SessionStorage for SqliteStore {
    async fn save(&self, session: Session) -> Result<(), GraphError> {
        let mut db = self.db.lock().await;
        save_session(&mut *db, session).await
    }
    async fn get(&self, id: &str) -> Result<Option<Session>, GraphError> {
        let mut db = self.db.lock().await;
        SessionRow::filter_by_id(id)
            .first()
            .exec(&mut *db)
            .await
            .map_err(graph_error)?
            .map(|row| row.into_session().map_err(graph_error))
            .transpose()
    }
    async fn delete(&self, id: &str) -> Result<(), GraphError> {
        let mut db = self.db.lock().await;
        sql::statement("DELETE FROM graph_sessions WHERE id = ?1")
            .bind(id)
            .exec(&mut *db)
            .await
            .map_err(graph_error)?;
        drop(db);
        Ok(())
    }
}

const fn status_name(status: &RunStatus) -> &'static str {
    match status {
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Failed { .. } => "failed",
        RunStatus::Skipped { .. } => "skipped",
    }
}
fn error(error: impl std::fmt::Display) -> WorkflowError {
    WorkflowError::Storage {
        message: error.to_string(),
    }
}
fn graph_error(error: impl std::fmt::Display) -> GraphError {
    GraphError::StorageError(error.to_string())
}

#[cfg(test)]
#[path = "storage_test.rs"]
mod tests;

async fn verify_migration_history(db: &mut Db) -> Result<(), WorkflowError> {
    let tables = sql::query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '__toasty_migrations'",
    )
    .exec(db)
    .await
    .map_err(error)?;
    if tables.is_empty() {
        return Ok(());
    }
    for row in MigrationRow::all().exec(db).await.map_err(error)? {
        row.validate().map_err(error)?;
        let id = u64::try_from(row.id).map_err(error)?;
        if !MIGRATIONS
            .migrations()
            .iter()
            .any(|migration| migration.id() == id && migration.name() == row.name)
        {
            return Err(error(format!(
                "unknown or altered applied SQLite migration {} ({})",
                row.id, row.name
            )));
        }
    }
    Ok(())
}

fn normalize_schema(sql: &str) -> String {
    let mut quoted = None;
    let mut normalized = String::new();
    for character in sql.trim().trim_end_matches(';').chars() {
        if let Some(delimiter) = quoted {
            normalized.push(character);
            if character == delimiter {
                quoted = None;
            }
        } else if matches!(character, '\'' | '"' | '`') {
            quoted = Some(character);
            normalized.push(character);
        } else if !character.is_whitespace() {
            normalized.push(character);
        }
    }
    normalized
}

async fn verify_clocks(executor: &mut dyn Executor, runs: &[RunRow]) -> Result<(), WorkflowError> {
    let clocks = ClockRow::all().exec(executor).await.map_err(error)?;
    for clock in &clocks {
        clock.validate().map_err(error)?;
    }
    for run in runs {
        run.validate().map_err(error)?;
    }
    let start_maximum = runs.iter().map(|run| run.start_order).fold(0, i64::max);
    let terminal_maximum = runs
        .iter()
        .filter_map(|run| run.terminal_order)
        .fold(0, i64::max);
    for (id, minimum) in [("start", start_maximum), ("terminal", terminal_maximum)] {
        let clock = clocks
            .iter()
            .find(|clock| clock.id == id)
            .ok_or_else(|| error(format!("missing SQLite ordering clock {id}")))?;
        if clock.value < minimum {
            return Err(error(format!(
                "SQLite ordering clock {id} precedes retained runs"
            )));
        }
    }
    Ok(())
}
