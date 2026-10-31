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
The maintained Reylo fork checkout is at `../../fork/package/reylo` relative to this checkout.
Both `reylo` and `@reylosql/sqlite` link to its built distributions, `dist/reylo` and `dist/sqlite`, as declared in `pnpm-workspace.yaml`.
Prepare and build that checkout before installing Flowdeck dependencies:

```sh
git clone https://github.com/totto2727-org/reylo.git ../../fork/package/reylo
# Check out the exact Reylo revision pinned by .github/workflows/ci.yml.
git -C ../../fork/package/reylo checkout --detach <pinned-revision>
vp env install
eval "$(vp env print)"
pnpm --dir ../../fork/package/reylo install --ignore-workspace --ignore-scripts --frozen-lockfile
node ../../fork/package/reylo/scripts/build.ts --sqlite
vp install --frozen-lockfile
vp run ci
```

Reuse an existing fork checkout instead of cloning over it.
The fork install uses `--ignore-workspace` so a containing pnpm workspace cannot substitute its own dependency installation.
It disables dependency lifecycle scripts with `--ignore-scripts`; the SQLite package build uses the locked package contents, including esbuild's platform package, without granting new build-script permissions or changing upstream dependency policy.
CI checks out the exact pinned fork commit at the same relative path, installs its dependencies, builds its SQLite distributions, and installs Flowdeck's locked dependencies before validation.
The fork's existing build task accepts `--sqlite` to build the runtime, declarations, and SQLite engine without unrelated documentation or playground builds.
The default full build remains unchanged.
Rebuild these distributions after editing the fork.
Linking its raw TypeScript source would make Flowdeck's strict compiler settings check upstream implementation files rather than the package declarations.
The distribution boundary retains the application's strict checks without rewriting unrelated upstream code.
Do not replace these links with published 0.6.0 packages, which do not provide the retained HCL source customization.

Reylo reads `schema/schema.hcl` directly through the maintained fork's HCL schema source.
The `.reylo.yaml` source is `direct_url: hcl:./schema/schema.hcl`.
The fork evaluates HCL through Atlas and analyzes the resulting schema in memory.
SQL import analysis needs no separate preparation task and creates no database file.
`vp run schema:check` validates migration checksums, renders the migration schema as SQL, replays that SQL in an in-memory Atlas development database, and compares the inspected HCL with the declared HCL.
The SQL rendering and memory replay normalize SQLite's implicit UNIQUE indexes through Atlas itself.
The check excludes no indexes, never changes migration files or D1, and fails with the proposed SQL when differences remain.
Only disposable `.atlas/migrations.sql`, `.atlas/migrations.hcl`, and `.atlas/drift.sql` artifacts are written.
Every Atlas development database uses `--dev-url "sqlite://dev?mode=memory"`.
Do not use `atlas schema apply` or create `.db` files for analysis, validation, or migration generation.
No D1 credentials, Wrangler-managed database, or network database service is required for SQL analysis.
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
For another Node-based Alchemy entry point, preload `reylo/register` before evaluating resource modules.
SQL compilation is a build-time operation; the deployed Worker uses the resulting query objects with its native D1 binding.

## Schema changes

Edit `schema/schema.hcl`, generate and review a new versioned SQL migration with Atlas, and keep applied migrations immutable.
Review generated SQL before committing it, especially when triggers depend on changed columns.
Refresh `migrations/atlas.sum` with `atlas migrate hash` after adding an intentionally reviewed migration.
Alchemy continues to apply the ordinary SQL migration files through the existing `Database` resource declaration.
Generate against the migration directory with an in-memory development database:

```sh
atlas migrate diff describe_change --dir file://migrations --to file://schema/schema.hcl --dev-url 'sqlite://dev?mode=memory'
```

Atlas can propose redundant replacements for implicit UNIQUE indexes in existing migrations.
Do not apply generated changes without review.
Never point local analysis or migration generation at a deployment database.

## Atomic writes and the public query contract

The store uses ordinary Reylo query execution for reads.
Creation and commits prepare all statements and submit them together through native `D1Database.batch`.
The receipt guard, revision update, snapshot, and events must not be split into separate query calls.
The commit acknowledgment is read only after that batch succeeds.

The maintained Reylo fork exposes its existing Standard Query contract at `query['~standard'].query`.
The store passes its public `text` to native D1 `prepare` and its `encode(input)` values to `bind`.
Reylo owns placeholder ordering, parameter validation, and encoding, with inferred query parameters retained at the store boundary.
Flowdeck does not add a SQL compiler, access private query internals, or patch a batch-binding method.
See [upstream differences](upstream-differences.md) for fork provenance and retained changes.

## Official references

- [Reylo setup](https://reylo.dev/#setup)
- [Reylo source](https://github.com/colinhacks/reylo)
- [Atlas versioned migrations](https://atlasgo.io/versioned/intro)
- [Atlas SQLite triggers](https://atlasgo.io/guides/sqlite/triggers)
- [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Official Atlas CI setup](https://atlasgo.io/integrations/github-actions)
