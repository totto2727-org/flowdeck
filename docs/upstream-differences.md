# Retained upstream differences

## Reylo source dependency

- Upstream: [colinhacks/reylo](https://github.com/colinhacks/reylo).
- Exact upstream base: [`73562e513ef50d54df51daefa5243fa8427df7af`](https://github.com/colinhacks/reylo/tree/73562e513ef50d54df51daefa5243fa8427df7af).
- Fork: [totto2727-org/reylo at `a557dd5e1fecaaa29eca131be6810d31995d117a`](https://github.com/totto2727-org/reylo/tree/a557dd5e1fecaaa29eca131be6810d31995d117a).
- Delivery: local distribution links for `reylo` and `@reylosql/sqlite` in `pnpm-workspace.yaml`, resolved from `../../fork/package/reylo/dist/reylo` and `../../fork/package/reylo/dist/sqlite`.
- Build customization: the fork's existing `scripts/build.ts --sqlite` builds its runtime, declarations, and SQLite engine without unrelated documentation or playground builds, while the default full build remains unchanged.
- Type boundary: consume the built declarations instead of checking upstream implementation files under Flowdeck's stricter compiler settings.
- Reproducibility: [CI](../.github/workflows/ci.yml) checks out an exact fork commit at the relative source path, installs its dependencies, builds the SQLite distributions, and installs Flowdeck's locked dependencies before checking Flowdeck.
- Setup: follow the source checkout and installation commands in [database workflow](database.md).

## Local HCL schema source

- Purpose: infer SQL query inputs and results directly from `schema/schema.hcl`, without preparing a file-backed analysis database.
- Affected areas: the fork's project source resolution, analysis and mapper paths, and HCL evaluation adapter.
- Configuration: `.reylo.yaml` uses `direct_url: hcl:./schema/schema.hcl`.
- Implementation boundary: Atlas evaluates the local HCL, and the existing Reylo SQLite analysis engine analyzes the resulting schema in memory.
- Operational impact: Atlas is required for local SQL import analysis, but no D1 credentials, remote database connection, schema apply task, or `.db` file is required.
- Classification: this is a build-time schema-source customization, not a deployment customization or a runtime SQL execution change.
- Removal criterion: adopt an age-eligible upstream release supporting the required direct HCL analysis source and remove the local distribution links when published packages cover both linked packages.

## Native D1 atomic writes

The store consumes the existing upstream Standard Query contract at `query['~standard'].query`.
Its public `text` and `encode(input)` supply native D1 `prepare`, `bind`, and `batch` without a custom compiler or batch-binding patch.
The fork adds no `compile(input)` method, D1 driver, SQL parser, or alternate parameter encoder.
Upstream runtime source behavior is unchanged.
Flowdeck preserves inferred input types at its generic preparation boundary and commits receipts, revisions, snapshots, and events in one native D1 batch.
The commit acknowledgment is read only after that batch succeeds.
Client-free Standard Query encoding does not perform live-schema freshness checks or decode database results.
Atlas migration/HCL drift validation and the application's real local D1 migration tests guard those boundaries.

The TypeScript Content Mapper, SQLite inference rules, Vite/Rolldown integration, ordinary query execution, and runtime parameter encoding remain upstream implementations.
The fork's own [retained differences](https://github.com/totto2727-org/reylo/blob/a557dd5e1fecaaa29eca131be6810d31995d117a/docs/upstream-differences.md) describe its source changes and native SQLite regression coverage.
Keep the exact upstream base and CI fork revision current when syncing or updating the fork.
