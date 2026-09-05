# Flowdeck dependency compatibility patch

This directory contains the source of the published `graph-flow` 0.6.0 crate.
The original normalized manifest, source files, README, roadmap, and Cargo VCS metadata were copied from the local crates.io source cache.
`Cargo.toml.orig` is the unchanged original manifest retained for provenance, not the active build manifest.
The registry extraction marker and standalone lockfile are omitted because this dependency uses Flowdeck's workspace lockfile.

## Upstream provenance

- Crate: <https://crates.io/crates/graph-flow/0.6.0>
- Published source: <https://docs.rs/crate/graph-flow/0.6.0/source/>
- Repository: <https://github.com/a-agmon/rs-graph-llm>
- Revision recorded by `.cargo_vcs_info.json`: `f18bf6a197fda9ee47f2ad21a625e985740e0cbb`, directory `graph-flow`.
- License: MIT.
- The published package omits the license file, so `LICENSE` is copied from the exact upstream revision: <https://raw.githubusercontent.com/a-agmon/rs-graph-llm/f18bf6a197fda9ee47f2ad21a625e985740e0cbb/LICENSE>.

## Local change

The only build or behavior change is `default-features = false` on the existing SQLx 0.8.6 dependency in `Cargo.toml`.
The explicitly requested `runtime-tokio-rustls`, `postgres`, `json`, `macros`, and `uuid` features remain unchanged.
All Rust source files are byte-for-byte identical to the published package.
The crate's SQLx calls are confined to `src/storage_postgres.rs`, which uses `PgPoolOptions`, `Pool<Postgres>`, `query`, and `query_as`.
It does not use SQLite, SQLx Any, or SQLx migration APIs.

This patch allows the application to investigate using Toasty 0.10's SQLite driver without enabling unrelated SQLx defaults.
The application owns the root `[patch.crates-io]` entry and integration validation.
Remove this local patch when an upstream release exposes compatible SQLx feature selection.
