//! Turso persistence for workflow snapshots, graph sessions, and schedule leases.

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
use toasty_driver_turso::Turso;
use tokio::sync::Mutex;

use crate::{
    HistoryView, RunId, RunSnapshot, RunStatus, RunTrigger, TursoLocation, TursoStateConfig,
    WorkflowError,
};

mod models;
mod run_dto;
mod session_dto;
use models::{LeaseRow, MigrationRow, RunRow, RunStatusRow, SessionRow};

const INITIAL_SQL: &str = include_str!("storage/migrations/0001_initial.sql");
const CURRENT_SCHEMA: &str = include_str!("storage/schema.sql");
const MIGRATIONS: MigrationSet =
    MigrationSet::new(&[MigrationFile::new(1, "0001_initial.sql", INITIAL_SQL)]);

#[allow(
    clippy::redundant_pub_crate,
    reason = "The live database store is intentionally crate-internal, not application public API."
)]
pub(crate) struct TursoStore {
    db: Mutex<Db>,
    remote: Option<Turso>,
    // A file service owns its database exclusively, so startup recovery cannot interrupt another service.
    _file_lock: Option<File>,
}

impl TursoStore {
    #[cfg(test)]
    pub(crate) async fn execute_test_sql(&self, statement: &str) -> Result<(), WorkflowError> {
        let mut db = self.db.lock().await;
        sql::statement(statement)
            .exec(&mut *db)
            .await
            .map_err(error)?;
        self.replicate_committed().await;
        drop(db);
        Ok(())
    }

    pub(crate) async fn open(config: &TursoStateConfig) -> Result<Self, WorkflowError> {
        // Preserve an explicit application choice, otherwise select a Rustls
        // provider before Turso starts its IO thread.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let (url, file_lock) = match &config.location {
            TursoLocation::Memory => ("turso::memory:".to_owned(), None),
            TursoLocation::File(path) => {
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
                (format!("turso:{path}"), Some(file))
            }
        };
        let mut driver = Turso::new(&url).map_err(error)?;
        if let Some(remote) = &config.remote {
            driver = driver
                .with_remote_url(remote.url())
                .with_auth_token(remote.auth_token())
                .with_long_poll_timeout(std::time::Duration::from_secs(1));
        }
        let remote = config.remote.as_ref().map(|_| driver.clone());
        let mut builder = Db::builder();
        builder
            .models(toasty::models!(RunRow, SessionRow, LeaseRow, MigrationRow))
            .max_pool_size(1)
            .pool_max_connection_lifetime(None)
            .pool_max_connection_idle_time(None);
        let mut db =
            tokio::time::timeout(std::time::Duration::from_secs(30), builder.build(driver))
                .await
                .map_err(|_| error("Turso connection timed out"))?
                .map_err(|cause| {
                    if remote.is_some() {
                        error("Turso remote connection failed")
                    } else {
                        error(cause)
                    }
                })?;
        if let Some(remote) = &remote {
            // Preserve locally committed changes from an interrupted/offline process before pulling.
            sync_push(remote).await?;
            tokio::time::timeout(std::time::Duration::from_secs(30), remote.pull())
                .await
                .map_err(|_| error("Turso remote pull timed out"))?
                .map_err(|_| error("Turso remote pull failed"))?;
        }
        verify_migration_history(&mut db).await?;
        MIGRATIONS.apply(&db).await.map_err(error)?;
        let store = Self {
            db: Mutex::new(db),
            _file_lock: file_lock,
            remote,
        };
        store.verify_schema().await?;
        store.recover().await?;
        store.flush_remote().await?;
        Ok(store)
    }

    // A failed replication must not orphan a locally committed run or lease by
    // reporting its creation as failed. Explicit flush exposes replication errors.
    async fn replicate_committed(&self) {
        if self.sync_remote().await.is_err() {
            tracing::warn!(
                "Turso replication failed; changes remain local and will be retried on the next write or explicit flush"
            );
        }
    }

    async fn sync_remote(&self) -> Result<(), WorkflowError> {
        if let Some(driver) = &self.remote {
            sync_push(driver).await?;
        }
        Ok(())
    }

    pub(crate) async fn flush_remote(&self) -> Result<(), WorkflowError> {
        let guard = self.db.lock().await;
        let result = self.sync_remote().await;
        drop(guard);
        result
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
        let json = run_dto::encode(&snapshot)?;
        let row = RunRow {
            id: snapshot.run_id.to_string(),
            started_at: epoch_millis(snapshot.started_at)?,
            finished_at: snapshot.finished_at.map(epoch_millis).transpose()?,
            status: RunStatusRow::from(&snapshot.status),
            snapshot: json,
        };
        row.validate().map_err(error)?;
        RunRow::create()
            .id(row.id)
            .started_at(row.started_at)
            .finished_at(row.finished_at)
            .status(row.status)
            .snapshot(row.snapshot)
            .exec(&mut tx)
            .await
            .map_err(error)?;
        if let Some(session) = session {
            save_session(&mut tx, session).await.map_err(error)?;
        }
        tx.commit().await.map_err(error)?;
        self.replicate_committed().await;
        Ok(())
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
        rows.sort_by(|left, right| (left.started_at, &left.id).cmp(&(right.started_at, &right.id)));
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
        tx.commit().await.map_err(error)?;
        self.replicate_committed().await;
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
        self.replicate_committed().await;
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
        self.replicate_committed().await;
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
        tx.commit().await.map_err(error)?;
        self.replicate_committed().await;
        Ok(())
    }
}

async fn sync_push(driver: &Turso) -> Result<(), WorkflowError> {
    tokio::time::timeout(std::time::Duration::from_secs(30), driver.push())
        .await
        .map_err(|_| error("Turso remote push timed out; local changes may already be committed"))?
        .map_err(|_| error("Turso remote push failed; local changes may already be committed"))
}

// Query columns use milliseconds; the snapshot retains its original SystemTime precision.
fn epoch_millis(time: SystemTime) -> Result<i64, WorkflowError> {
    i64::try_from(
        time.duration_since(SystemTime::UNIX_EPOCH)
            .map_err(error)?
            .as_millis(),
    )
    .map_err(error)
}

async fn persist_mutation(
    executor: &mut dyn Executor,
    snapshot: &RunSnapshot,
) -> Result<(), WorkflowError> {
    let json = run_dto::encode(snapshot)?;
    sql::statement(
        "UPDATE runs SET snapshot = ?1, status = ?2, started_at = ?3, finished_at = ?4 WHERE id = ?5",
    )
    .bind(json)
    .bind(RunStatusRow::from(&snapshot.status).as_str())
    .bind(epoch_millis(snapshot.started_at)?)
    .bind_typed(
        snapshot.finished_at.map(epoch_millis).transpose()?,
        toasty::schema::db::Type::Integer(8),
    )
    .bind(snapshot.run_id.as_str())
    .exec(executor)
    .await
    .map_err(error)?;
    if snapshot.status != RunStatus::Running
        && let RunTrigger::Cron { schedule_id } = &snapshot.trigger
    {
        sql::statement("DELETE FROM schedule_leases WHERE id = ?1")
            .bind(schedule_id.as_str())
            .exec(executor)
            .await
            .map_err(error)?;
    }
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
impl SessionStorage for TursoStore {
    async fn save(&self, session: Session) -> Result<(), GraphError> {
        let mut db = self.db.lock().await;
        save_session(&mut *db, session).await?;
        self.replicate_committed().await;
        drop(db);
        Ok(())
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
        self.replicate_committed().await;
        drop(db);
        Ok(())
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

#[cfg(test)]
#[path = "storage_remote_test.rs"]
mod remote_tests;
