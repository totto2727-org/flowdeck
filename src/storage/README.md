# Turso schema maintenance

`migrations/` contains ordered SQL migrations applied by Toasty 0.10's `MigrationSet`.
The sole initial migration is being rewritten while this PR remains unreleased, so databases created by an earlier draft have no upgrade path.
After the initial schema ships, never edit an already shipped migration or reset an existing database.
Each migration statement is separated by `-- #[toasty::breakpoint]` and each migration is applied transactionally by Toasty.

`schema.sql` records the expected **latest** table definitions, separately from migration history.
For this unreleased initial schema, update the migration and schema snapshot together.
After release, changing a model requires a new migration, an updated current schema snapshot, and an upgrade test for a populated database.
The snapshot includes primary keys, inline unique indexes, nullability, and CHECK constraints.
Startup rejects missing or drifted definitions instead of attempting destructive repair.

The Turso pool has one connection for private memory databases and a process-local mutex serializes operations.
Every operation involving multiple writes uses the same Toasty transaction, including run/session creation, completion and lease release.
File-backed services hold an exclusive OS file lock for their lifetime.
On reopening a file, interrupted runs become failed and stale schedule leases are released in one transaction.
No run-count retention limit or automatic history/session deletion is applied at startup or during writes.
This also applies to in-memory databases: storage usage grows with history.
Run and step timestamp columns store Unix epoch milliseconds plus a `0..=999_999` submillisecond-nanosecond remainder, preserving the represented `SystemTime` precision.
Runs, graph sessions, and individual step traces use normalized fixed columns instead of whole snapshot or session payload JSON.
JSON is limited to workflow input, redacted step state, and graph-flow context; context and input must be JSON objects.
Traversal, current edge, and duration are reconstructed from ordered `run_steps` and the persisted start/finish timestamps.
`RunRow.status` is a dedicated `RunStatusRow` unit enum derived with `toasty::Embed`, separate from the domain status.
Toasty stores its variants in the existing single text column as `running`, `completed`, `failed`, or `skipped`, with the database CHECK constraint unchanged.
Enum decoding replaces free-form status-string validation, while row-to-snapshot conversion still checks lifecycle consistency.
History sorts by start milliseconds ascending and then run ID ascending for ties, without unique timestamps or global sequence counters.
The initial migration is rewritten only while this PR is unreleased. It deliberately provides no upgrade from earlier draft databases.
There is a single initial migration and no separate generated metadata or runtime SQL checksums to update.
Graphs, runtime resources, driver admission, and broadcast channels remain process-local execution infrastructure, not serialized database data.

## Remote synchronization

`TursoStateConfig::remote` accepts `TursoRemoteConfig` connection settings through `ApplicationConfig`.
Configuration requires nonempty URL/token strings and passes them unchanged to Turso; format and connection validation belong to the driver.
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
