# Retained upstream differences

## Unpublished Reylo customization

- Upstream: [colinhacks/reylo](https://github.com/colinhacks/reylo).
- Exact upstream base: [`73562e513ef50d54df51daefa5243fa8427df7af`](https://github.com/colinhacks/reylo/tree/73562e513ef50d54df51daefa5243fa8427df7af).
- Fork: [totto2727-org/reylo at `a9a0aa0c80f0af955dd8e72d3db486005e07a092`](https://github.com/totto2727-org/reylo/tree/a9a0aa0c80f0af955dd8e72d3db486005e07a092).
- Delivery status: the HCL customization is unpublished. Committed dependencies resolve registry packages, not this fork.
- Local validation: an operator may temporarily link the fork's built `dist/reylo` and `dist/sqlite` packages without committing the link configuration.
- Build workflow for that local checkout: retain upstream's nub workflow, frozen installs at the fork root and in `site/`, and the standard full build. Engine distributions retain the required MPL license packaging for the HCL parser port.
- Type boundary: local validation consumes built declarations, not upstream implementation files under Flowdeck's stricter compiler settings.
- CI: no source checkout, fork build, nub setup, committed link override, or package patch is used to bypass publication. Registry-only HCL checks remain blocked until a suitable release exists.
- Setup and acceptance limits: see [database workflow](database.md).

## Local HCL schema source

- Purpose: infer SQL query inputs and results directly from `schema/schema.hcl`, without opening a host analysis database.
- Affected areas: the fork's project source resolution, analysis and mapper paths, and HCL evaluation adapter.
- Configuration: `.reylo.yaml` uses `direct_url: hcl:./schema/schema.hcl`.
- Implementation boundary: the native HCL parser port reads the local source, and the static Atlas SQLite adapter supplies DDL catalog rows directly to the existing Reylo engine. It opens no Node SQLite database and performs no host SQL execution. The engine's existing embedded SQLite parser and internal schema replay remain unchanged.
- Parser provenance: HashiCorp HCL v2.25.0 at `00057cf06d7b38a3f89e6e54d622eee98322b314`, with MPL-2.0 notices and scoped upstream parser/scanner regressions retained inside the fork.
- Semantic scope: static SQLite schema declarations only, with unsupported HCL evaluation, declarations, and invalid references rejected explicitly.
- Operational impact: SQL import analysis needs no Atlas executable, Go runtime, subprocess, D1 credentials, remote database, host database, schema apply task, or `.db` file. HCL content hashes replace database fingerprint queries. Static inference uses the embedded engine's built-in functions and does not establish a live D1 function allowlist. Atlas remains limited to migration management, HCL formatting, and definition validation.
- Classification: this is a build-time schema-source customization, not a deployment customization or a runtime SQL execution change.
- Adoption criterion: use an age-eligible published package supporting the direct HCL analysis source. No permanent source-delivery workaround is retained while awaiting publication.

## Native D1 atomic writes

The store consumes the existing upstream Standard Query contract at `query['~standard'].query`.
Its public `text` and `encode(input)` supply native D1 `prepare`, `bind`, and `batch` without a custom compiler or batch-binding patch.
The fork adds no `compile(input)` method, D1 driver, SQL parser, or alternate parameter encoder.
Upstream runtime source behavior is unchanged.
Flowdeck preserves inferred input types at its generic preparation boundary and commits receipts, revisions, snapshots, and events in one native D1 batch.
The commit acknowledgment is read only after that batch succeeds.
Client-free Standard Query encoding does not perform live-schema freshness checks or decode database results.
The application's real local D1 migration tests exercise the stored-schema and atomic-write contracts.

The TypeScript Content Mapper, SQLite inference rules, Vite/Rolldown integration, ordinary query execution, and runtime parameter encoding remain upstream implementations.
The fork's own [retained differences](https://github.com/totto2727-org/reylo/blob/a9a0aa0c80f0af955dd8e72d3db486005e07a092/docs/upstream-differences.md) describe its source changes and native SQLite regression coverage.
Keep the exact upstream base and locally verified fork revision current when syncing or updating the fork.
