# Database workflow

## Ownership

Flowdeck targets SQLite and Cloudflare D1 only.
Atlas HCL in [`schema/schema.hcl`](../schema/schema.hcl) defines tables, columns, checks, foreign keys, and indexes.
Versioned SQL in [`migrations/`](../migrations/) remains the deployment input for Alchemy's D1 resource.
Atlas does not deploy to D1.
Reylo infers query input and result types from the SQL files in `src/features/workflow/services/queries/`.
There is no handwritten TypeScript table model or query builder.

Atlas Community does not model SQLite triggers.
The existing revision, idempotency, graph-identity, and run-identity triggers therefore remain reviewed SQL in the migration history.
Do not remove them when generating table changes from HCL.
The HCL drift check covers tables and indexes, not trigger definitions.
D1 integration tests exercise the trigger contracts against the actual migration files.

## Local analysis and checks

Install the [official Atlas CLI](https://atlasgo.io/getting-started/) and the official Vite+ CLI.
Resolve JavaScript tools through Vite+, then install the locked dependencies:

```sh
vp env install
vp install --frozen-lockfile
vp run ci
```

The canonical tasks prepare `.atlas/schema.db` from HCL before checking or testing SQL imports.
`vp run schema:check` validates the migration checksum and compares the replayed migration schema with HCL.
Atlas normalizes SQLite's implicit UNIQUE constraints into named indexes when rendering HCL.
The check therefore materializes the inspected migration HCL in a separate disposable SQLite file before comparing it with the declared schema.
This uses Atlas's own normalization, excludes no indexes, and never changes the runtime migration files or D1.
A nonempty difference fails the check and prints the proposed SQL.
This is a disposable, local SQLite file containing schema only, not a remote database or production data.
The default `.reylo.yaml` points only to that file.
No D1 credentials, Wrangler-managed database, or network database service is required for SQL analysis.
Reylo prepares queries against SQLite schema, so this is local schema-backed analysis rather than an HCL-only parser.
Do not commit `.atlas/` or `.reylo/`.

`vp run typecheck` runs the official TypeScript 7.1 compiler with `--runExternalCode` and the registered Reylo Content Mapper.
That flag permits the installed mapper to execute during compilation.
`vp run check` adds Vite+ formatting and type-aware lint.
Vite+'s separate TypeScript 7.0 backend cannot resolve Content Mapper imports, so its duplicate full type check is disabled, not substituted with ambient `any` declarations.
The canonical check still type-checks the complete project through TypeScript 7.1.
Use `vp run check`, not standalone `vp check`, for the complete check.

The official `reylo/vite` plugin handles SQL modules in Vite/Vitest and Alchemy's Rolldown Worker bundles.
`vp run dev` also preloads the official `reylo/register` Node hook because Alchemy evaluates resource modules before bundling Workers.
Playwright uses that same startup task.
For another Node-based Alchemy entry point, prepare the local schema and preload `reylo/register` before evaluating resource modules.
SQL compilation is a build-time operation; the deployed Worker uses the resulting query objects with its native D1 binding.

## Schema changes

Edit `schema/schema.hcl`, generate and review a new versioned SQL migration with Atlas, and keep applied migrations immutable.
Review generated SQL before committing it, especially when triggers depend on changed columns.
Refresh `migrations/atlas.sum` with `atlas migrate hash` after adding an intentionally reviewed migration.
Alchemy continues to apply the ordinary SQL migration files through the existing `Database` resource declaration.
Never point local schema preparation at a deployment database.

## Atomic writes and the Reylo patch

The store uses ordinary Reylo query execution for reads.
Creation and commits prepare all statements and submit them together through native `D1Database.batch`.
The receipt guard, revision update, snapshot, and events must not be split into separate query calls.
The commit acknowledgment is read only after that batch succeeds.

Published Reylo 0.6.0 has no public checked binder for an external atomic batch.
A small pnpm patch exposes its existing binder as `query.compile(input)` without replacing SQL parsing, type inference, parameter validation, or encoding.
See the exact upstream revision, retained difference, and removal criteria in [upstream differences](upstream-differences.md).
The patch is installed through the lockfile, not by editing `node_modules` after installation.

## Official references

- [Reylo setup](https://reylo.dev/#setup)
- [Reylo source](https://github.com/colinhacks/reylo)
- [Atlas versioned migrations](https://atlasgo.io/versioned/intro)
- [Atlas SQLite triggers](https://atlasgo.io/guides/sqlite/triggers)
- [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Official Atlas CI setup](https://atlasgo.io/integrations/github-actions)
