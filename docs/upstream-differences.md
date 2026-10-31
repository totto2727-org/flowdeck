# Retained upstream differences

## Reylo atomic-batch binding

- Upstream: [colinhacks/reylo](https://github.com/colinhacks/reylo).
- Comparison revision: [`5b9a07adaf5a37c89313fda615e186b109300865`](https://github.com/colinhacks/reylo/tree/5b9a07adaf5a37c89313fda615e186b109300865), the published `reylo@0.6.0` source revision.
- Fork source comparison revision: [`73562e513ef50d54df51daefa5243fa8427df7af`](https://github.com/colinhacks/reylo/tree/73562e513ef50d54df51daefa5243fa8427df7af), the upstream `main` revision on which the fork change is based.
- Delivery: the pnpm patch for `reylo@0.6.0`, installed reproducibly by the application lockfile; the same SQLite-only API is maintained and reviewed in the fork.
- Purpose: obtain validated, encoded SQL parameters before submitting all writes to a single native D1 atomic batch.
- Affected area: the public runtime query's `compile(input)` method and its TypeScript declaration.
- Implementation boundary: the fork delegates to Reylo's existing `rawStatement` binder, and the published-package patch delegates to that release's existing `statement` binder; neither adds a SQL parser, type inferencer, parameter-order implementation, or Cloudflare-specific query engine.
- Operational impact: compilation can reject invalid parameters before any D1 statement executes; actual database constraints still run inside `D1Database.batch`.
- Limit: client-free binding does not perform the live client's schema-freshness check; Atlas migration/HCL drift checks and the D1 migration tests guard this boundary.
- Removal criterion: adopt an age-eligible upstream release exposing an equivalent checked bind/compile or Standard Query interface, then remove the patch and adapt the narrow batch boundary.

The TypeScript 7.1 Content Mapper, SQLite analysis engine, Vite/Rolldown plugin, ordinary query execution, and D1 runtime driver remain upstream implementations.
The application consumes the SQLite binding change reviewed in [Reylo fork PR #1](https://github.com/totto2727-org/reylo/pull/1), commit [`f7f566b`](https://github.com/totto2727-org/reylo/commit/f7f566b), as a patch against the published 0.6.0 package.
The fork tracks upstream separately; the application does not alter the SQLite analysis engine.
