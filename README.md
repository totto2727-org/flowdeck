# Flowdeck

A local-only workflow dashboard built with Topcoat, Datastar, Tailwind CSS, and graph-flow, with jcode available as an optional agent-node integration. It runs code-defined workflows manually or on cron schedules, keeps execution history in memory, and exposes node and edge traces for debugging and performance analysis.

## Usage

Open <http://127.0.0.1:3000/> after starting the server. The root redirects to the first code-defined workflow. Choose a workflow, enter its run arguments, and select **Run workflow**. Select any node or edge in the graph with a pointer, Enter, or Space to inspect its retained state, timing, output, error, and selected route.

Workflow selection starts at `/workflows/{workflow_id}`. When that workflow has retained runs, the server redirects this abbreviated URL to its newest exact `/workflows/{workflow_id}/runs/{run_id}` path. A workflow with no runs redirects to its exact `/workflows/{workflow_id}/runs/` path, which renders the workflow topology without a step trace or run inspector. Reloading or bookmarking an exact run path restores the same in-memory run while the server process remains alive. Unknown workflows, runs, and paths return an HTTP 404 recovery page and then return through `/` to the first workflow and its newest run.

The server emits `tracing` events for its listening URL and completed HTTP requests. Set `RUST_LOG=flowdeck=info` to enable these application logs when a broader environment filter is already configured.

Datastar sends the selected workflow and its workflow-owned input to the Rust action. A long-lived SSE response streams server-rendered snapshot patches, including cron-triggered runs, without browser polling:

```bash
curl -N 'http://127.0.0.1:3000/events/history?after=0'
curl -i -X POST http://127.0.0.1:3000/actions/runs \
  -H 'Datastar-Request: true' \
  -H 'content-type: application/json' \
  --data '{"selectedWorkflowId":"demo-workflow","input":{"label":"local check","step_delay_ms":350}}'
```

Run-history filters are applied on the server using `history_workflow`, `history_trigger`, and `history_status` URL query parameters. Missing or invalid values normalize to `all`; canonical URLs omit `all` values and retain only active filters in a stable order. Reloading, sharing, and browser navigation therefore restore the same server-rendered history without cookies. The run SSE is scoped to the selected `/runs/{run_id}` path, while the history SSE receives only the normalized filter query and streams history-row deltas.

## Key features

- Three code-defined workflows covering branching, linear review, and a complete jcode coding-agent turn.
- Workflow-owned forms whose data is deserialized by Serde, validated by garde, and applied as the initial graph-flow context.
- Multiple code-defined cron schedules with skip-while-running and allow-overlap policies.
- Workflow and node execution limits that bound loops and long-running tasks.
- Automatically laid out SVG topology with external self-loop routing and active, traversed, selected, and execution-count states.
- Per-execution node and edge traces with timestamps, elapsed time, state, output, errors, and exact `StepId` history.
- An optional jcode integration with one lazily started shared process and isolated or reusable named sessions.
- URL-addressable server-rendered run-history filtering with separate run and history SSE streams.

## Prerequisites

- **Nix**: Recommended for the packaged application and its bundled assets.
- **Rust 1.95 and Topcoat CLI 0.5**: Required only when running directly through Cargo.

## Setup

1. Run the packaged application with Nix.

```bash
nix run .
```

2. Alternatively, install the matching Topcoat asset CLI and run through Cargo.

```bash
cargo install --version '0.5' topcoat-cli
just run
```

3. Open <http://127.0.0.1:3000/>.

## API

This local application does not publish a stable external Rust API.
See [Flowdeck Architecture](./docs/architecture.md) for its HTTP boundaries and internal workflow, configuration, scheduler, state, SSE, and renderer extension contracts.

## Development

For the current system design, see [docs/architecture.md](./docs/architecture.md) or its [Japanese translation](./docs/architecture.ja.md).
For the optional node integration, see [graph-flow-jcode architecture](./crates/graph-flow-jcode/docs/architecture.md) or its [Japanese translation](./crates/graph-flow-jcode/docs/architecture.ja.md).
For repository structure and development commands, see [AGENTS.md](./AGENTS.md).

## Documentation

- [Topcoat 0.5.0 on crates.io](https://crates.io/crates/topcoat/0.5.0)
- [Topcoat Datastar integration](https://github.com/tokio-rs/topcoat/blob/371c7403fcbf4d40bbacb2f87eb98d9ce00e76c8/crates/topcoat/docs/datastar.md)
- [Topcoat Tailwind integration](https://github.com/tokio-rs/topcoat/blob/371c7403fcbf4d40bbacb2f87eb98d9ce00e76c8/crates/topcoat/docs/tailwind.md)
- [graph-flow 0.6.0 on crates.io](https://crates.io/crates/graph-flow/0.6.0)
- [garde 0.23.0 documentation](https://docs.rs/garde/0.23.0/garde/)
- [Croner 3.0.1 documentation](https://docs.rs/croner/3.0.1/croner/)

## License

MIT

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
