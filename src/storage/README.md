# SQLite schema maintenance

`migrations/` contains immutable, ordered SQL migrations applied by Toasty 0.10's `MigrationSet`.
Never edit an already shipped migration or reset an existing database.
Each migration statement is separated by `-- #[toasty::breakpoint]` and each migration is applied transactionally by Toasty.

`schema.sql` records the expected **latest** table definitions, separately from migration history.
When changing a model, add a new migration to `MIGRATIONS`, update this current schema snapshot, and add a test that upgrades a populated database from the previous version without losing its data.
The snapshot includes primary keys, inline unique indexes, nullability, and CHECK constraints.
Startup rejects missing or drifted definitions instead of attempting destructive repair.
A migration change is not complete until both fresh initialization and populated upgrade tests pass.

The SQLite pool has one connection for private memory databases and a process-local mutex serializes operations.
Every operation involving multiple writes uses the same Toasty transaction, including run/session creation, completion, lease release, ordering counters, and terminal retention.
File-backed services hold an exclusive OS file lock for their lifetime.
On reopening a file, interrupted runs become failed, stale schedule leases are released, and retention is applied in one transaction.
Graphs, runtime resources, driver admission, and broadcast channels remain process-local execution infrastructure, not serialized database data.
