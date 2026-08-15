# Workflow Console Experiment

Local-only Topcoat 0.5.0 workflow dashboard pinned to upstream commit `88859796d88fac504be1b8e40a70d6f0dbacaaaa` and Rust 1.95. It exposes one code-defined branch/converge workflow, runs it through the real in-memory service, and retains run history until the server process exits.

## Surface

- `GET /` renders the operational dashboard.
- `GET /api/state` returns the workflow topology and all retained runs, newest first.
- `POST /api/runs` accepts `{"workflow_id":"demo-workflow"}` and returns the new run. Unknown IDs return HTTP 400 with a rejected JSON response and are not retained.

## Local commands

```bash
topcoat asset bundle
cargo run
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/api/state
curl -i -X POST http://127.0.0.1:3000/api/runs \
  -H 'content-type: application/json' \
  --data '{"workflow_id":"demo-workflow"}'
```

Install the pinned asset CLI if `topcoat` is unavailable:

```bash
cargo install --git https://github.com/tokio-rs/topcoat \
  --rev 88859796d88fac504be1b8e40a70d6f0dbacaaaa topcoat-cli
```

```bash
cargo fmt --all -- --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build
node --check src/app.js
```

## Topcoat references

- [Asset bundling at the pinned revision](https://github.com/tokio-rs/topcoat/blob/88859796d88fac504be1b8e40a70d6f0dbacaaaa/crates/topcoat/docs/asset.md)
- [Application context at the pinned revision](https://github.com/tokio-rs/topcoat/blob/88859796d88fac504be1b8e40a70d6f0dbacaaaa/crates/topcoat/docs/app_context.md)
- [JSON request and response example at the pinned revision](https://github.com/tokio-rs/topcoat/blob/88859796d88fac504be1b8e40a70d6f0dbacaaaa/examples/request-response/src/main.rs)
