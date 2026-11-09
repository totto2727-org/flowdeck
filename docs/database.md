# Database workflow

## Ownership

Flowdeck targets SQLite and Cloudflare D1 only.
Atlas Pro HCL in [`schema/`](../schema/) defines tables, columns, checks, foreign keys, indexes, and triggers.
Versioned SQL in [`migrations/`](../migrations/) remains the deployment input for Alchemy's D1 resource.
Atlas does not deploy to D1.
Reylo infers query input and result types from the SQL files in `src/features/workflow/services/queries/`.
There is no handwritten TypeScript table model or query builder.

D1 integration tests exercise the generated migration files.

## Local analysis and checks

Install the [official Atlas CLI](https://atlasgo.io/getting-started/) and the official Vite+ CLI.
For local migration generation, authenticate with `atlas login` using an Atlas Pro organization.
CI installs Atlas with `ariga/setup-atlas` and runs schema validation without a token.
The committed package manifest and lockfile use registry dependencies.
CI uses the shared TypeScript setup action and does not fetch or build unpublished Reylo source.

Install the published `@totto2727/reylo` runtime and `@totto2727/reylo-sqlite` tooling at matching versions through the committed manifest and lockfile.
CI installs these registry packages without a fork checkout, source build, or local package link.

Reylo reads `schema/schema.hcl` directly through the maintained fork's HCL schema source.
The `.reylo.yaml` source is `direct_url: hcl:./schema/schema.hcl`.
The fork parses HCL in process with its port of HashiCorp's native parser and supplies supported static Atlas SQLite declarations as DDL catalog rows directly to the existing Reylo engine.
This path opens no Node SQLite database and performs no host SQL execution.
The engine's existing embedded SQLite parser and internal schema replay remain unchanged.
HCL content hashes replace database fingerprint queries and invalidate cached analysis when the source changes.
Static inference uses the embedded engine's built-in functions, not a live D1 function allowlist.
SQL import analysis requires neither the Atlas executable nor a Go runtime, remote service, host database, or application database.
The JavaScript tooling parses HCL and delegates schema analysis to the published upstream native engine in a child process.
Unknown declarations, dynamic HCL expressions, invalid references, and syntax errors are rejected rather than ignored.
Atlas manages migrations and checks HCL definitions separately from Content Mapper or SQL loader analysis.
SQL import analysis needs no separate preparation task and creates no database file.
Every Atlas development database uses `--dev-url "sqlite://dev?mode=memory"`.
Do not use `atlas schema apply` or create `.db` files for analysis, validation, or migration generation.
No D1 credentials, Wrangler-managed database, or network database service is required for SQL analysis.
Do not commit `.atlas/` or `.reylo/`.

`vp run check` depends on `check:tsc`, which runs the official TypeScript 7.1 compiler with `--runExternalCode` and the registered Reylo Content Mapper, then runs Vite+ formatting checks and type-aware lint.
That flag permits the installed mapper to execute during compilation.
This is temporary: Vite+ 1.4.0 still reports `TS2307` for the project's SQL imports with its full type check enabled.
When `vp check` supports SQL Content Mappers, enable its full type check and remove the temporary `check:tsc` task and dependency.
`vp run fix` also formats `atlas.hcl` and schema HCL with `atlas schema fmt atlas.hcl schema`.
`vp run check` validates the HCL definition with `atlas schema validate --env schema`.
The `schema` environment in [`atlas.hcl`](../atlas.hcl) defines the HCL directory and in-memory SQLite development database.
This loads the definition without comparing schemas, checking migration checksums, applying migrations, or creating a database file.
`vp run test` runs the application tests without additional migration checksum or schema drift checks.
Do not substitute ambient `any` declarations for SQL inference.
The canonical check still type-checks the complete project through TypeScript 7.1.
Use `vp run check`, not standalone `vp check`, for the complete check.

The official `@totto2727/reylo/vite` plugin handles SQL modules in Vite/Vitest and Alchemy's Rolldown Worker bundles.
`vp run dev` also preloads the official `@totto2727/reylo/register` Node hook because Alchemy evaluates resource modules before bundling Workers.
Playwright uses that same startup task.
For another Node-based Alchemy entry point, preload `@totto2727/reylo/register` before evaluating resource modules.
SQL compilation is a build-time operation; the deployed Worker uses the resulting query objects with its native D1 binding.

## Schema changes

Edit the HCL definitions under `schema/` and generate a versioned SQL migration with Atlas.
Keep the generated output unchanged by default.
Correct the HCL source and regenerate instead of patching the SQL.
The undeployed application uses one generated initial migration.
After deployment, keep applied migrations immutable and generate new migrations for schema changes.
Review generated SQL before committing it.
Alchemy applies the generated SQL through the `Database` resource declaration.
Generate against the migration directory with an in-memory development database:

```sh
atlas migrate diff describe_change --env schema
```

Never point local analysis or migration generation at a deployment database.

## Atomic writes and the public query contract

`AlchemyQueryExecutorLive` adapts the selected `WorkflowDatabase` Alchemy service to the client-independent `QueryExecutor` contract from `@totto2727/reylo/effect`.
`DatabaseQueriesLive` captures that executor once through `makeQueryRunner` and captures the Alchemy client for batch preparation.
`D1StoreLive` requires `DatabaseQueries`; Worker, run Durable Object, and test composition roots supply both Layers with their selected database Layer.
`D1StoreLive` constructs the `Store` service from separate operation factories that capture those query capabilities once.
Service methods do not provide or rebuild their dependencies when called.
`d1-store.ts` defines each run, graph, event, creation, and commit operation separately; `d1-store-codecs.ts` owns persisted value conversion.
`database-queries.ts` adapts Alchemy's object-row executor and captures Reylo's published runner; `database.ts` translates storage failures, and `d1-batch.ts` owns the native batch Effect.
Reylo owns parameter encoding, result decoding, and inferred cardinality; Alchemy executes queries through `PreparedStatement.all`.
Reylo depends on neither Alchemy nor D1 and does not own Flowdeck's storage error mapping.
Creation and commits submit prepared statements together through Alchemy's `batch`, which delegates to one native atomic D1 batch.
Flowdeck's `batch` is an independent Effect function that captures the Alchemy client during service construction and accepts only `PreparedStatement[]`.
Each calling operation prepares and binds the statements before invoking it; the batch Effect does not prepare statements.
The store never evaluates the client's `raw` binding or recreates its Promise-to-Effect executor.
The receipt guard, revision update, snapshot, and events must not be split into separate query calls.
The commit acknowledgment is read only after that batch succeeds.

The published `@totto2727/reylo/effect` entry point exposes `makeQueryRunner` for reads and `prepare` for statement text and ordered values without execution.
Flowdeck binds the prepared values through Alchemy before calling the independent batch Effect.
Reylo decodes object rows and enforces query cardinality, then domain Schema codecs validate persisted values.
Reylo owns placeholder ordering, parameter validation, and encoding, with inferred query parameters retained at the store boundary.
Flowdeck does not add a SQL compiler, access private query internals, or patch a batch-binding method.
Worker and Effect-native Durable Object entry points obtain the client through `QueryDatabaseBinding`.
Miniflare database tests provide `D1Binding` to `NativeWorkflowDatabase`, which delegates to Alchemy's existing client builder.
Production Workers and Durable Objects do not use this native-binding test adapter.
A version-scoped dependency patch exports that builder from the D1 entry point without modifying its implementation.
See [upstream differences](upstream-differences.md) for provenance, patch scope, and removal criteria.

Alchemy reports rejected D1 operations as defects.
The executor converts query defects to Reylo's `QueryExecutionError`; storage translation retains the original cause from preparation, execution, or decoding failures.
Native batch defects also become typed storage failures, and interruption remains interruption.
Database constraint conflicts use `StorageConflict`, with a required operation and cause; domain validation conflicts use `Conflict`, with only a message.
The owning service logs the original cause and stack with an error ID before returning a sanitized [RPC problem](rpc-boundaries.md).
Control receives a new local error whose cause is that problem object, not the database exception.
It maps the problem to the corresponding safe HTTP response, including 409 for conflicts.
Control registers its local failure logging and HTTP error translation through `HttpRouter.middleware`.

## Official references

- [Reylo setup](https://reylo.dev/#setup)
- [Reylo source](https://github.com/colinhacks/reylo)
- [Atlas versioned migrations](https://atlasgo.io/versioned/intro)
- [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Official Atlas CI setup](https://atlasgo.io/integrations/github-actions)
