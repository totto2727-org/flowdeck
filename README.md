# Workflow Console Experiment

Local-only workflow dashboard built with Topcoat 0.5-compatible and graph-flow 0.6-compatible crates.io releases on Rust 1.95. It exposes two code-defined workflows, accepts workflow-owned input defaults as the initial graph-flow context, runs manual and cron-triggered executions through the same in-memory service, and retains run history until the server process exits.

## Surface

- `GET /` renders the operational dashboard.
- `GET /api/state` returns every workflow definition with its input configuration and topology, plus all retained runs newest first. Each run includes per-node traces with typed state, start/finish timestamps, elapsed time, output or error, and the selected edge.
- `POST /api/runs` accepts a workflow ID plus `label` and `step_delay_ms` input, then returns the new manual run. Invalid inputs and unknown IDs return HTTP 400 and are not retained.
- Select `Branch and converge` or `Review pipeline`, adjust that workflow's run input, and start it from the shared form. Select any node or edge in the active SVG with a pointer, Enter, or Space to inspect its retained trace.
- The code-defined `*/10 * * * * *` schedule starts the same workflow every ten seconds with its own initial input. Schedule state and history remain in memory and stop with the server.

## Local commands

```bash
topcoat asset bundle
cargo run
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/api/state
curl -i -X POST http://127.0.0.1:3000/api/runs \
  -H 'content-type: application/json' \
  --data '{"workflow_id":"demo-workflow","input":{"label":"local check","step_delay_ms":350}}'
```

Workflow-owned code is grouped by definition. The application and web layers import only the shared registry:

```text
src/workflows.rs
src/workflows/demo/definition.rs
src/workflows/review/definition.rs
src/workflows/task.rs
```

Install the matching asset CLI if `topcoat` is unavailable:

```bash
cargo install --version '0.5' topcoat-cli
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

- [Topcoat 0.5.0 on crates.io](https://crates.io/crates/topcoat/0.5.0)
- [Topcoat getting started](https://github.com/tokio-rs/topcoat/blob/main/crates/topcoat/docs/getting_started.md)
- [graph-flow 0.6.0 on crates.io](https://crates.io/crates/graph-flow/0.6.0)

## Cron reference

- [Croner 3.0.1 crate documentation](https://docs.rs/croner/3.0.1/croner/)
- [Required seconds-field parser](https://docs.rs/croner/3.0.1/croner/parser/enum.Seconds.html)
- [Next-occurrence API](https://docs.rs/croner/3.0.1/croner/struct.Cron.html#method.find_next_occurrence)
