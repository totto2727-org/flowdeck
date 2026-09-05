# SQLite state migration based on PR2

Status: implementation design and evidence, with integration validation tracked by the implementation handoff.

## Decision

Replace every application-owned mutable data store behind `ApplicationState` with one Toasty 0.10 SQLite backend.
Keep the default database in memory and apply committed SQL migrations before constructing the workflow service or starting HTTP and cron workers.
This replaces collection-backed storage without silently making local runs persistent across process restarts.
File-backed storage is an explicit configuration option and requires interrupted-run recovery rather than automatic replay of external effects.
Preserve PR2's separate non-serializable `ResourceStore` and task-local propagation unchanged.

## Baseline inventory

The inventory below refers to PR2 commit `c442f1e`, before SQLite implementation changed these files.
Line locations deliberately describe that fixed baseline rather than concurrently edited working-tree line numbers.

| Store or state | Baseline location | SQLite treatment |
| --- | --- | --- |
| Shared graph-flow sessions | `src/workflow/state.rs:13-30`, `src/workflow/bootstrap.rs:17-24,79-90` | Replace `InMemorySessionStorage` with a `SessionStorage` adapter backed by the shared database. |
| Active runs | `src/workflow/history.rs:19-22,45-49` | Persist active `RunSnapshot` data, never evict it through terminal retention. |
| Terminal runs, including skipped and rejected cron attempts | `src/workflow/history.rs:19-22,51-54,66-74`, `src/workflow/schedule_attempt.rs:12-72` | Replace the terminal ring with bounded database retention in terminal-transition order. |
| Global start-order sequence | `src/workflow/history.rs:14-16,22,34-42,86-92` | Persist a monotonic sequence independently from terminal retention order. |
| Per-run step trace, topology progress, input, status and timing | `src/lib.rs:61-126`, `src/workflow_trace.rs:11-149` | Persist through validated storage DTOs or explicit model fields, including exact `StepId`, node execution ordinal, selected edge, output, redacted state, error and times. |
| Schedule overlap leases | `src/workflow/state.rs:185-206`, `src/workflow_scheduler.rs:118-171` | Replace the mutex-protected schedule ID set with a unique-key table and atomic claim/release. |
| Named provider session descriptors | `crates/graph-flow-jcode/src/runtime.rs:57-76,101-132` | Distinguish serializable `SessionKey` to provider session identity/working-directory metadata from live attached sessions and their turn mutexes. The current map is an integration-owned runtime registry, not a graph session database. |
| Agent output and chat history | `crates/graph-flow-jcode/src/node.rs:178-215`, `crates/graph-flow-jcode/src/output.rs`, graph-flow `src/context.rs:307-311,564-600` | Already contained in serializable graph-flow context. Preserve them through the complete session round trip without publishing private context as a UI trace. |

Run snapshots contain manual/cron trigger metadata, normalized input and its summary, current node and edge, ordered traversed nodes and edges, route summary, start/finish times, durations, and all step traces.
Repeated nodes and edges are ordered occurrences rather than sets.
Skipped schedules create terminal snapshots with zero steps and no graph-flow session.
A migration covering history alone or graph-flow sessions alone would leave a mixed backend and is insufficient.

### What must remain process-local

- `src/workflow.rs:55-70`: the workflow runtime map contains `FlowRunner`, input parsers, trace projector trait objects, and references to code-defined definitions.
- `src/workflows.rs` and `src/workflows/registration.rs`: graph definitions, task closures, input defaults, forms, and schedules are code-owned configuration, not mutable durable records.
- `src/workflow/tasks.rs:6-24`: `WorkflowTasks` owns `Arc<ResourceStore>` and `TaskTracker`, which track live execution rather than data.
- `crates/workflow-resources/src/lib.rs:77-87,168-196`: heterogeneous `Arc<dyn Any + Send + Sync>` resources, their initialization locks, and Tokio task-local bindings must never be serialized.
- `src/workflow/run_group.rs:6-12,20-33`: the process-wide semaphore and owned permits enforce concurrent drivers and must be recreated, not restored from database counts as live permits.
- `src/workflow.rs:60,152-154` and `src/features/{run_history,run_detail}/sse.rs`: broadcast senders, receivers, and SSE streams are invalidation delivery resources, not durable event storage.
- `src/workflow_scheduler.rs:174-192,201-254`: prepared cron objects, duplicate-ID validation sets, worker `JoinSet`, sleep futures, and the next occurrence are runtime values rebuilt from code-defined schedules and the clock.
- `crates/graph-flow-jcode/src/runtime.rs:74-76,136-140`: `JcodeClient`, process/socket ownership, attached session `Arc`s, `Mutex<()>` turn serialization, lazy `OnceLock`, and initializer closures remain integration resources.
- `src/features/run_detail/component/topology/geometry.rs`: temporary layout maps, traversal queues, and rendered geometry are recomputed projections.
- Browser-selected node/edge/step, filter query parameters, form signals, and request-local render models remain UI/request state unless a separate user preference persistence requirement is introduced.
- Workflow-loaded credentials and process launch environment remain at their existing provider/configuration boundary, never in database rows or graph context.

Persisting a provider session reference does not persist the provider's conversation files.
The current private jcode runtime and ephemeral home do not establish restartable agent conversations.
An eventual restartable descriptor would need provider identity, stable session ID, working directory, runtime key, and a durable provider home or external runtime, while recreating its locks and client.

## Concrete storage model

The implementation in `src/storage.rs` uses explicit Toasty table names and the committed migration `src/storage/migrations/0001_initial.sql`.
It stores opaque serialized payloads beside fields needed for indexing and concurrency:

| Table role | Required columns and constraints |
| --- | --- |
| `graph_sessions` / `SessionRow` | Text `id` primary key, positive signed 64-bit `version`, JSON-valid text `payload`. |
| `runs` / `RunRow` | Text `id` primary key, unique positive `start_order`, nullable unique positive `terminal_order`, constrained `status`, JSON-valid text `snapshot`. Running status requires a null terminal order. |
| `store_clocks` / `ClockRow` | `id` is `start` or `terminal`, with a nonnegative signed 64-bit `value`. Updates reject exhaustion before incrementing. |
| `schedule_leases` / `LeaseRow` | Unique nonblank text `id`. A file-backed service holds an exclusive file lock, so the current database has only one owning service. |
| Migration bookkeeping | Toasty's standard `__toasty_migrations` table, owned by the migration API and read through a validation-only `MigrationRow` to reject incompatible history. |

The existing ring evicts by insertion into the terminal ring, not by run start time.
Preserve this by allocating terminal order when a run finishes or an unstarted schedule attempt is inserted, while `HistoryView` remains sorted by start order.
A schema based only on `started_at`, UUID ordering, or the start sequence will change observable retention for runs that finish out of order.
Use checked conversions for `u64`, `usize`, durations and timestamps because SQLite integers are signed 64-bit values.
Keep storage DTO versioning and validation distinct from application domain models.
JSON decode failures must be actionable storage errors, not an absent row or an empty history.
`src/storage/run_dto.rs` validates versioned run/step wire data with Garde before restoring domain values.
`src/storage/session_dto.rs` validates a separate `schema_version = 1` envelope whose other fields match graph-flow's session wire shape: `id`, `graph_id`, `current_task_id`, `status_message`, `context`, and optimistic-lock `version`.
Session identifiers must be nonblank, context must be an object, and the lock version must fit SQLite's signed integer range.
The context envelope is restored through graph-flow's own Serde contract, preserving opaque workflow values and chat history, while `Session` itself is explicitly constructed only after DTO validation.
`SessionRow::into_session` separately checks the decoded ID and lock version against the indexed row metadata.
The schema version never replaces or increments the compare-and-swap version.

## Toasty 0.10 APIs

The release package records source revision `f3411327b6b57fb03deac9e49f7021d1448176be` in `.cargo_vcs_info.json`.
The published default-feature rustdoc omits feature-gated migration items, so a missing migration rustdoc URL does not mean that the release lacks the API.
The release source explicitly exports `migration` and `embed_migrations!` behind the `migration` feature.

```toml
[dependencies]
toasty = { version = "0.10", features = ["sqlite", "migration"] }
```

```rust,ignore
let db = toasty::Db::builder()
    .models(toasty::models!(SessionRow, RunRow, LeaseRow, ClockRow))
    .max_pool_size(1)
    .connect("turso::memory:")
    .await?;

MIGRATIONS.apply(&db).await?;
```

`Sqlite::in_memory()` passed to `Builder::build` is an equivalent driver-based startup path.
Do not create a separate in-memory database for each store or workflow.
`Db::clone` shares the same connection pool, and the SQLite in-memory driver caps that pool at one connection.
Disabling connection lifetime/idle eviction avoids accidentally dropping the sole connection that owns the database.

A basic model uses `#[derive(Debug, toasty::Model)]`, an explicit `#[table = "graph_sessions"]`, and `#[key] id: String`.
`String` maps to `TEXT`, `i64` to `BIGINT`, and `Option<T>` to nullable columns.
For domain JSON payloads, an explicit `String` column plus Serde conversion avoids relying on a domain type implementing Toasty's field traits.

Verified read patterns are `Row::all().exec(&mut db).await?`, `Row::filter_by_id(id).first().exec(&mut db).await?` for `Option<Row>`, and `Row::filter_by_id(id).get(&mut db).await?` when a missing row is an error.
`Row::get_by_id(&mut db, &id).await?` is the immediate primary-key form.
Use `toasty::sql::statement(sql).bind(value).exec(&mut db).await?` for a backend statement returning affected-row count.
Use `toasty::sql::query(sql)` when rows are required, noting that raw results are dynamic `Value::Record` rows rather than hydrated models.
SQLite bind placeholders are numbered `?1`, `?2`, and so on.

Begin a transaction with `let mut tx = db.transaction().await?`, execute every participating operation through `&mut tx`, and finish with `tx.commit().await?`.
Dropping an uncommitted transaction rolls it back.
Do not hold this transaction while running a workflow task, waiting for a jcode turn, or checking out another connection from the shared pool.
SQLite supports serializable isolation but not row-level `SELECT FOR UPDATE` locking.

## Committed migrations

Toasty 0.10 supports two standard embedding forms:

```rust,ignore
static MIGRATIONS: toasty::migration::MigrationSet = toasty::embed_migrations!();
```

The application selects the explicit `MigrationSet::new` form with a static `MigrationFile::new(1, "0001_initial.sql", include_str!(...))` entry for `src/storage/migrations/0001_initial.sql`.
This reuses Toasty's transactional apply and migration-ID tracking without requiring runtime SQL files, a custom runner, or a migration CLI.
`TursoStore::verify_schema` also compares the expected table declarations with SQLite's retained schema before recovery, rejecting table drift.
The `toasty/` layout below describes an optional generator workflow, not the application's current migration path.

For generated migrations, use a project-local binary built on `toasty-cli` 0.10 and the same model registry as the application.
`ToastyCli::with_config(db, Config::load()?).parse_and_run().await?` provides generation and application commands.
Commit the SQL under `toasty/migrations/`, the corresponding schema snapshots under `toasty/snapshots/`, and `toasty/history.toml` together.
Add canonical non-interactive Just tasks when exposing this developer workflow.
Rename detection can prompt interactively, so it must not be relied on in unattended CI.

`MigrationSet::apply(&db)` checks applied IDs, skips already applied migrations, and invokes the driver's transactional migration operation for each pending file.
Separate SQL statements with `-- #[toasty::breakpoint]` when using the generated migration format.
Do not call `reset_db` or `push_schema` during ordinary application startup.
`push_schema` pushes a complete schema rather than tracking changes, while resetting is destructive for a file-backed database.
Embedded migration application tracks IDs, not runtime checksum equality, so treat released migration IDs and SQL as immutable and add a new migration for changes.

## Atomicity and recovery

1. Insert the initial graph session and running snapshot together before returning success or spawning its driver.
2. Allocate a step's exact identity and persist its running trace before emitting `NodeStarted`.
3. Preserve graph-flow's compare-and-swap contract: every successful save, including the initial insert, stores incoming `version + 1`, and a stale save produces `GraphError::SessionConflict`.
4. If version is stored both in a SQL column and serialized payload, update both consistently inside the same atomic operation.
5. Use a conditional update or `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE version = ?` and check affected rows, not an unconditional overwrite following a separate read.
6. Finish/fail the snapshot, release its schedule lease, and apply terminal retention atomically where their domain boundary permits it.
7. Preserve broadcast notifications as post-commit invalidations rather than making their delivery part of database durability.
8. Reconcile file-backed interrupted runs before starting cron workers, marking them failed/interrupted and releasing stale leases instead of replaying side effects automatically.

Graph-flow's own save occurs inside `FlowRunner::run`, while Flowdeck records its projected trace afterward.
Sharing a database does not make those two operations one transaction automatically.
A process can stop after a session advances but before the visible trace finishes, so restart policy must handle this explicitly.
Optimistic locking cannot roll back filesystem edits, provider requests, or other external effects performed before a stale save is rejected.
A dropped async timeout also does not terminate an already-running synchronous `spawn_blocking` agent turn.

The baseline retained graph sessions after terminal history eviction and had no named jcode-session removal path.
The SQLite implementation now deletes graph sessions associated with evicted terminal runs in the same retention transaction, while the integration's live-session lifetime remains a separately owned policy.
On file-backed startup, the service acquires an exclusive file lock, validates retained rows, marks interrupted running snapshots and their active steps failed, clears leases, and applies retention transactionally.
It never runs a graph task during recovery.
Removing the single-owner restriction would require owner-aware leases and a startup-recovery ownership rule before stale-state cleanup is safe.
Provider descriptors, durable provider homes and restartable agent conversations are tracked by [follow-up issue #3](https://github.com/totto2727-org/flowdeck/issues/3) rather than being claimed as SQLite migration guarantees.

## Dependency compatibility

The workspace uses Toasty's embedded Turso driver with a private in-memory database by default and optional local file storage.
The committed SQLite-compatible schema and validated DTO/domain boundaries remain unchanged.
All workspace crates share the published graph-flow dependency; no local vendor patch or Git revision override is required.
The published graph-flow package still depends on SQLx, but the Turso driver does not introduce the conflicting native SQLite dependency used by Toasty's SQLite driver.
Optional validated remote URL/token configuration uses the Turso sync driver; see the [remote synchronization contract](../../src/storage/README.md#remote-synchronization).
Remote mode requires a single Flowdeck writer per remote database and is not a distributed storage backend.

## Verification requirements

- Fresh SQLite-memory startup applies the committed SQL and exposes all registered workflows without starting an optional provider.
- Applying the same migration set twice changes nothing on the second pass and preserves inserted rows.
- A failed migration rolls back its changes and is not marked applied.
- Independently built memory services are isolated, while all adapters within one service share the same database.
- Graph session save/get/delete preserves graph ID, task ID, status message, context values, chat history, and version.
- Concurrent stale session saves yield exactly one successful update and a typed conflict, including version overflow handling.
- History round trips preserve repeated step identities, selected edges, ordering, failures, and nanosecond timing where supported by the DTO.
- Terminal eviction follows completion order, never removes an active run, and obeys the explicit associated-session retention policy.
- Schedule claims are atomic under concurrency, skipped attempts are retained, and completion/failure/start rejection release ownership.
- File-backed reopen preserves terminal history and reconciles interrupted runs and leases without rerunning graph tasks.
- Storage errors propagate through service, HTTP and SSE rather than being converted to an empty result or silent scheduler skip.
- The real console workflow and lagged SSE refresh remain coordinator-owned browser QA.
- Run the pinned-environment `just ci` gate and dependency-resolution checks after integration settles.

This investigation verified source contracts and release APIs, not the completed SQLite end-user workflow.
The implementation handoff records actual build, test, migration and browser results separately.

## Official sources

- Toasty 0.10 API: <https://docs.rs/toasty/0.10.0/toasty/>
- Builder and pool configuration: <https://docs.rs/toasty/0.10.0/toasty/db/struct.Builder.html>
- Database and transaction API: <https://docs.rs/toasty/0.10.0/toasty/db/struct.Db.html>
- Raw SQL: <https://docs.rs/toasty/0.10.0/toasty/sql/index.html>
- Turso driver and remote sync: <https://docs.rs/toasty-driver-turso/0.10.0/toasty_driver_turso/struct.Turso.html>
- Feature-gated migration exports: <https://docs.rs/crate/toasty/0.10.0/source/src/lib.rs>
- Release identity: <https://docs.rs/crate/toasty/0.10.0/source/.cargo_vcs_info.json>
- Release-fixed migration guide: <https://raw.githubusercontent.com/tokio-rs/toasty/f3411327b6b57fb03deac9e49f7021d1448176be/docs/guide/src/schema-management.md>
- Release-fixed SQLite guide: <https://raw.githubusercontent.com/tokio-rs/toasty/f3411327b6b57fb03deac9e49f7021d1448176be/docs/guide/src/sqlite.md>
- Release-fixed query guide: <https://raw.githubusercontent.com/tokio-rs/toasty/f3411327b6b57fb03deac9e49f7021d1448176be/docs/guide/src/querying-records.md>
- Embedded migration implementation: <https://raw.githubusercontent.com/tokio-rs/toasty/f3411327b6b57fb03deac9e49f7021d1448176be/crates/toasty/src/migration/embed.rs>
- Graph-flow session storage contract: <https://docs.rs/graph-flow/0.6.0/graph_flow/storage/trait.SessionStorage.html>
- Published graph-flow source: <https://docs.rs/crate/graph-flow/0.6.0/source/>
