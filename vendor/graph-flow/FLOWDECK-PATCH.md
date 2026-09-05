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

The SQLx 0.8.6 facade dependency is replaced by exact-version `sqlx-core` and `sqlx-postgres` 0.8.6 dependencies with default features disabled.
Tokio, Rustls with ring and WebPKI roots, PostgreSQL, JSON, and UUID support are preserved through their corresponding component features.
The unused SQLx Any, migration, and procedural macro surfaces are not enabled.
`src/storage_postgres.rs` imports `Pool`, `query`, and `query_as` directly from `sqlx-core` and `PgPoolOptions` and `Postgres` from `sqlx-postgres`.
These are the same types and functions re-exported by the facade, so the public storage API and SQL statements remain unchanged.
Every other Rust source file is byte-for-byte identical to the published package.
The crate's SQLx calls are confined to `src/storage_postgres.rs`, which uses `PgPoolOptions`, `Pool<Postgres>`, `query`, and `query_as`.
It does not use SQLite, SQLx Any, or SQLx migration APIs.

Merely disabling facade defaults did not resolve Cargo's native-library `links` conflict between SQLx's optional SQLite dependency and Toasty 0.10's SQLite driver.
Using only the PostgreSQL component removes that competing SQLite dependency from the resolution graph.
The component versions are pinned because the runtime and TLS feature names are lower-level SQLx interfaces.
The application owns the root `[patch.crates-io]` entry and integration validation.
Remove this local patch when an upstream release exposes compatible SQLx feature selection.
