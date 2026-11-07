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
Authenticate with `atlas login` using an Atlas Pro organization.
CI supplies the `ATLAS_CLOUD_TOKEN` secret to `ariga/setup-atlas`.
The committed package manifest and lockfile use registry dependencies.
CI uses the shared TypeScript setup action and does not fetch or build unpublished Reylo source.

The HCL source support is currently available only in [Reylo PR #1](https://github.com/totto2727-org/reylo/pull/1), not in the declared published 0.6.0 packages.
Full checks and startup using this source remain blocked on a suitable published package in a clean registry-only installation.
Do not bypass that prerequisite in CI, disable checks, or restore committed links, patches, or source-build steps.

To test the unpublished changes locally, build an existing fork checkout with its standard nub workflow, then link its built `dist/reylo` and `dist/sqlite` packages into this checkout with `pnpm link`.
Use the fork's built declarations rather than its raw TypeScript source.
Treat any dependency, workspace, or lockfile edits made by that local link as temporary and do not commit them.
Run `vp run ci` against those local links and report the result as local fork validation, not clean registry-only CI acceptance.
Remove the local links before checking the committed dependency installation.

Reylo reads `schema/schema.hcl` directly through the maintained fork's HCL schema source.
The `.reylo.yaml` source is `direct_url: hcl:./schema/schema.hcl`.
The fork parses HCL in process with its port of HashiCorp's native parser and supplies supported static Atlas SQLite declarations as DDL catalog rows directly to the existing Reylo engine.
This path opens no Node SQLite database and performs no host SQL execution.
The engine's existing embedded SQLite parser and internal schema replay remain unchanged.
HCL content hashes replace database fingerprint queries and invalidate cached analysis when the source changes.
Static inference uses the embedded engine's built-in functions, not a live D1 function allowlist.
SQL import analysis requires neither the Atlas executable nor a Go runtime, subprocess, remote service, host database, or application database.
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

The official `reylo/vite` plugin handles SQL modules in Vite/Vitest and Alchemy's Rolldown Worker bundles.
`vp run dev` also preloads the official `reylo/register` Node hook because Alchemy evaluates resource modules before bundling Workers.
Playwright uses that same startup task.
For another Node-based Alchemy entry point, preload `reylo/register` before evaluating resource modules.
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

`D1StoreLive` obtains the selected Alchemy `QueryDatabaseClient` through the `WorkflowDatabase` Context service and Layer composition.
Reylo supplies SQL, inferred input and row types, and parameter encoding; Alchemy executes reads through `first` and `all`.
Creation and commits submit prepared statements together through Alchemy's `batch`, which delegates to one native atomic D1 batch.
The store never evaluates the client's `raw` binding or recreates its Promise-to-Effect executor.
The receipt guard, revision update, snapshot, and events must not be split into separate query calls.
The commit acknowledgment is read only after that batch succeeds.

The maintained Reylo fork exposes its existing Standard Query contract at `query['~standard'].query`.
The store passes its public `text` to Alchemy's `prepare` and its `encode(input)` values to `bind`.
Domain Schema codecs validate persisted row values after execution.
Reylo owns placeholder ordering, parameter validation, and encoding, with inferred query parameters retained at the store boundary.
Flowdeck does not add a SQL compiler, access private query internals, or patch a batch-binding method.
Worker and Effect-native Durable Object entry points obtain the client through `QueryDatabaseBinding`.
The native Pi Durable Object and Miniflare tests provide `D1Binding` to `NativeWorkflowDatabase`, which delegates to Alchemy's existing client builder.
A version-scoped dependency patch exports that builder from the D1 entry point without modifying its implementation.
See [upstream differences](upstream-differences.md) for provenance, patch scope, and removal criteria.

Alchemy reports rejected D1 operations as defects.
The store translates those defects into typed storage failures, retains the original cause and stack, and leaves interruption unchanged.
Control registers failure logging and HTTP error translation through `HttpRouter.middleware`.
The logging Middleware records the original Effect cause once before HTTP translation, without logging request bodies or changing client error responses.

## Official references

- [Reylo setup](https://reylo.dev/#setup)
- [Reylo source](https://github.com/colinhacks/reylo)
- [Atlas versioned migrations](https://atlasgo.io/versioned/intro)
- [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Official Atlas CI setup](https://atlasgo.io/integrations/github-actions)
