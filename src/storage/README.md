# Turso schema maintenance

`migrations/` contains immutable, ordered SQL migrations applied by Toasty 0.10's `MigrationSet`.
Never edit an already shipped migration or reset an existing database.
Each migration statement is separated by `-- #[toasty::breakpoint]` and each migration is applied transactionally by Toasty.

`schema.sql` records the expected **latest** table definitions, separately from migration history.
When changing a model, add a new migration to `MIGRATIONS`, update this current schema snapshot, and add a test that upgrades a populated database from the previous version without losing its data.
The snapshot includes primary keys, inline unique indexes, nullability, and CHECK constraints.
Startup rejects missing or drifted definitions instead of attempting destructive repair.
A migration change is not complete until both fresh initialization and populated upgrade tests pass.

The Turso pool has one connection for private memory databases and a process-local mutex serializes operations.
Every operation involving multiple writes uses the same Toasty transaction, including run/session creation, completion, lease release, ordering counters, and terminal retention.
File-backed services hold an exclusive OS file lock for their lifetime.
On reopening a file, interrupted runs become failed, stale schedule leases are released, and retention is applied in one transaction.
Graphs, runtime resources, driver admission, and broadcast channels remain process-local execution infrastructure, not serialized database data.

## Remote synchronization

`TursoStateConfig::remote` accepts validated `TursoRemoteConfig` connection settings through `ApplicationConfig`.
The default remains `None` with an in-memory local database.
Remote mode uses Toasty's Turso sync driver, not a remote-only SQL transport.
Use one Flowdeck writer per remote database; a local file lock does not coordinate different machines.
Keep the configured local replica path dedicated to that remote database.

Startup bootstraps an empty replica, pushes pending local changes, pulls remote changes, validates the schema and stored rows, and publishes migration/recovery changes.
Local write transactions are serialized and followed by a best-effort remote push.
A push failure after local commit produces a redacted warning, but does not report a successful local run/lease creation as failed or replay workflow side effects.
Call `WorkflowService::flush_storage().await` for explicit confirmation of remote persistence; it returns an error if pending changes cannot be pushed.
Startup requires successful synchronization and fails closed if the remote is unavailable.
Subsequent pushes retry the pending local log.
A memory replica loses pending changes if the process exits before synchronization; use a file replica when offline durability is required.
Remote writes by another process during operation are unsupported; there is no distributed lease or continuous pull loop.
Connection, push, and pull operations have bounded waits, and connection errors do not include credentials.

The remote token is runtime configuration, is redacted from Debug output, and is not included in serialized application state.
Remote configuration currently uses the Rust API, not a new environment-variable or TOML configuration loader.
Temporary-file mode is not provided.

Driver reference: https://docs.rs/toasty-driver-turso/0.10.0/toasty_driver_turso/struct.Turso.html
