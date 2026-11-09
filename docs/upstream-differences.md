# Retained upstream differences

## Effront 0.4.0 declaration resolution

- Upstream release: [`@effront/alchemy@0.4.0`](https://www.npmjs.com/package/@effront/alchemy/v/0.4.0), based on release commit [`8e3bea2c3f2d7ebc852718052a848900f1b6f232`](https://github.com/totto2727-org/effront/commit/8e3bea2c3f2d7ebc852718052a848900f1b6f232).
- Patch: [`patches/@effront__alchemy@0.4.0.patch`](../patches/@effront__alchemy@0.4.0.patch), generated with `vp pm patch` and `vp pm patch-commit` and applied through the declared `patchedDependencies` entry.
- Purpose: repair published declaration module specifiers that Alchemy's public export map cannot resolve.
- Scope: only `dist/cloudflare/application.d.ts`, `application-runtime.d.ts`, `index.d.ts`, and `runtime.d.ts` change.
- Replacements: `alchemy/Cloudflare/CloudflareEnvironmentService` becomes `alchemy/Cloudflare` for `CloudflareEnvironment`, and `alchemy/Cloudflare/index` becomes `alchemy/Cloudflare/Workers` for Worker host services.
- Operational impact: restore TypeScript's application capability, request-scope, and error inference without casts, ambient module shims, or suppressed checks.
- Runtime source and JavaScript artifacts are unchanged, and this is not a deployment customization.
- TODO: remove this exact-version patch and its `patchedDependencies` entry after consuming a fixed published release from [Effront PR #33](https://github.com/totto2727-org/effront/pull/33).
- Regression coverage: `src/workers/frontend/features/worker.test.ts` asserts the configured helper's captured `ControlApi`, host-owned request and scope requirements, and typed failures through the normal TypeScript check.

## Published Reylo customization

- Upstream: [colinhacks/reylo](https://github.com/colinhacks/reylo).
- Exact upstream base: [`7a3928a8ff4dfb387b34ed584ab1319aa72f3f3b` (`v0.7.0`)](https://github.com/colinhacks/reylo/tree/7a3928a8ff4dfb387b34ed584ab1319aa72f3f3b).
- Effect API comparison revision: [`7c93c0c3ca3744635e319ae4eed501a529bffd57`](https://github.com/totto2727-org/reylo/tree/7c93c0c3ca3744635e319ae4eed501a529bffd57), the merged Effect integration from [PR 10](https://github.com/totto2727-org/reylo/pull/10). The published `0.7.1` metadata does not include a source commit.
- Packages: [`@totto2727/reylo@0.7.1`](https://www.npmjs.com/package/@totto2727/reylo/v/0.7.1) and [`@totto2727/reylo-sqlite@0.7.1`](https://www.npmjs.com/package/@totto2727/reylo-sqlite/v/0.7.1).
- Delivery: registry artifacts and their published declarations, with exact integrity values in `pnpm-lock.yaml`; no source checkout, fork build, local link, or Reylo patch.
- Native analysis: published upstream `@reylosql/engine-*` packages at `0.7.0`, selected for the host platform through optional dependencies.
- Temporary release-age exception: only the two scoped `0.7.1` packages are excluded from the 24-hour wait, with a removal TODO in `pnpm-workspace.yaml`. Other dependencies retain the waiting period.
- Setup and acceptance limits: see [database workflow](database.md).

## Local HCL schema source

- Purpose: infer SQL query inputs and results directly from `schema/schema.hcl`, without opening a host analysis database.
- Affected areas: the fork's project source resolution, analysis and mapper paths, and HCL evaluation adapter.
- Configuration: `.reylo.yaml` uses `direct_url: hcl:./schema/schema.hcl`.
- Implementation boundary: the native HCL parser port reads the local source, and the static Atlas SQLite adapter supplies DDL catalog rows directly to the existing Reylo engine. It opens no Node SQLite database and performs no host SQL execution. The engine's existing embedded SQLite parser and internal schema replay remain unchanged.
- Parser provenance: HashiCorp HCL v2.25.0 at `00057cf06d7b38a3f89e6e54d622eee98322b314`, with MPL-2.0 notices and scoped upstream parser/scanner regressions retained inside the fork.
- Semantic scope: static SQLite schema declarations only, with unsupported HCL evaluation, declarations, and invalid references rejected explicitly.
- Operational impact: SQL import analysis needs no Atlas executable, Go runtime, D1 credentials, remote database, host database, schema apply task, or `.db` file. HCL parsing runs in JavaScript; schema analysis runs in the upstream native engine child process. HCL content hashes replace database fingerprint queries. Static inference uses the embedded engine's built-in functions and does not establish a live D1 function allowlist. Atlas remains limited to migration management, HCL formatting, and definition validation.
- Classification: this is a build-time schema-source customization, not a deployment customization or a runtime SQL execution change.

## Effect execution and native D1 atomic writes

The optional `@totto2727/reylo/effect` entry point adds client-independent query execution with typed preparation, execution, and decoding failures.
Flowdeck supplies the executor through an Alchemy-backed `QueryExecutor` Layer at each Worker, Durable Object, or test composition root.
`makeQueryRunner` captures that executor during query-service construction and delegates row decoding and cardinality to Reylo.
Reylo has no D1 or Alchemy dependency, creates no client, and provides no batch or transaction abstraction.
The published `prepare` Effect supplies SQL text and ordered values for Alchemy's statement builder before Flowdeck calls its native batch Effect.
The fork adds no D1 driver, SQL parser, or alternate parameter encoder.
The upstream Promise and synchronous execution APIs retain their behavior; Effect execution is an optional runtime addition.
Flowdeck preserves inferred input types and commits receipts, revisions, snapshots, and events in one native D1 batch.
The commit acknowledgment is read only after that batch succeeds.
The Effect entry point does not perform live-schema freshness checks; domain Schema codecs still validate persisted application values after Reylo decodes rows.
The application's real local D1 migration tests exercise the stored-schema, decoding, executor capture, and atomic-write contracts.
Alchemy's Effect-native client owns query execution and delegates atomic writes to native D1.

The TypeScript Content Mapper, SQLite inference rules, Vite/Rolldown integration, ordinary query execution, and runtime parameter encoding remain upstream implementations.
The fork's own [retained differences](https://github.com/totto2727-org/reylo/blob/7c93c0c3ca3744635e319ae4eed501a529bffd57/docs/upstream-differences.md) describe its source changes and native SQLite regression coverage.
Keep the exact upstream base and source comparison revision current when updating the dependency.

## Alchemy native D1 client

- Upstream release: [`alchemy@2.0.0-beta.83`](https://www.npmjs.com/package/alchemy/v/2.0.0-beta.83), with the exact package integrity and patch hash recorded in `pnpm-lock.yaml`.
- Patch: [`patches/alchemy@2.0.0-beta.83.patch`](../patches/alchemy@2.0.0-beta.83.patch).
- Purpose: Miniflare database tests receive a native D1 binding without Alchemy's Worker construction context for `QueryDatabaseBinding`. Production Workers and Durable Objects obtain their client through Alchemy's Effect construction APIs.
- D1 scope: re-export the existing `makeQueryDatabaseClientFrom` from the D1 source entry point, emitted JavaScript, and declarations.
- D1 runtime implementation: unchanged; no copied executor, private imports, fake Worker resources, or alternative batch implementation.
- Operational impact: frozen dependency installation applies the D1 exports only; RPC serialization is unchanged, and no release-age exception, credential change, or schema change is required.
- Removal criterion: adopt an age-eligible Alchemy release exposing an equivalent public native-binding client or Layer, then remove the export patch.
