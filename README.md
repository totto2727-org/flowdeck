# Workflow Console Experiment

A local-only workflow dashboard built with Topcoat, Datastar, Tailwind CSS, and graph-flow. It runs code-defined workflows manually or on cron schedules, keeps execution history in memory, and exposes node and edge traces for debugging and performance analysis.

## Usage

Open <http://127.0.0.1:3000/> after starting the server. The root redirects to the first code-defined workflow. Choose a workflow, enter its run arguments, and select **Run workflow**. Select any node or edge in the graph with a pointer, Enter, or Space to inspect its retained state, timing, output, error, and selected route.

Workflow selection starts at `/workflows/{workflow_id}`. When that workflow has retained runs, the server redirects this abbreviated URL to its newest exact `/workflows/{workflow_id}/runs/{run_id}` path; a workflow with no runs keeps the workflow-only page so its first run can be started. Reloading or bookmarking an exact run path restores the same in-memory run while the server process remains alive. Unknown workflows, runs, and paths return an HTTP 404 recovery page and then return through `/` to the first workflow and its newest run.

The server emits `tracing` events for its listening URL and completed HTTP requests. Set `RUST_LOG=workflow_console_experiment=info` to enable these application logs when a broader environment filter is already configured.

Datastar sends the selected workflow and its workflow-owned input to the Rust action. A long-lived SSE response streams server-rendered snapshot patches, including cron-triggered runs, without browser polling:

```bash
curl -N http://127.0.0.1:3000/events
curl -i -X POST http://127.0.0.1:3000/actions/runs \
  -H 'Datastar-Request: true' \
  -H 'content-type: application/json' \
  --data '{"selectedWorkflowId":"demo-workflow","input":{"label":"local check","step_delay_ms":350}}'
```

Run-history filters are applied on the server before each HTML patch is rendered. Changing a filter reconnects the `/events` stream with the new Datastar signals, stores the normalized workflow, trigger, and status filters in local-only HTTP-only cookies, and restores those values after a reload.

## Key features

- Two code-defined workflows with branching, convergence, and observable sleep tasks.
- Workflow-owned forms whose data is deserialized by Serde, validated by garde, and applied as the initial graph-flow context.
- A code-defined cron schedule that uses the same in-memory execution service.
- SVG topology with active, traversed, and selected node and edge states.
- Per-node and per-edge traces with timestamps, elapsed time, state, output, and errors.
- Server-rendered run-history filtering with SSE reconnection and cookie-backed reload restoration.

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

## Development

For repository structure, development commands, CI, Nix, and FlakeHub operation, see [AGENTS.md](./AGENTS.md).

## Documentation

- [Topcoat 0.5.0 on crates.io](https://crates.io/crates/topcoat/0.5.0)
- [Topcoat Datastar integration](https://github.com/tokio-rs/topcoat/blob/371c7403fcbf4d40bbacb2f87eb98d9ce00e76c8/crates/topcoat/docs/datastar.md)
- [Topcoat cookie integration](https://github.com/tokio-rs/topcoat/blob/371c7403fcbf4d40bbacb2f87eb98d9ce00e76c8/crates/topcoat/docs/cookie.md)
- [Topcoat Tailwind integration](https://github.com/tokio-rs/topcoat/blob/371c7403fcbf4d40bbacb2f87eb98d9ce00e76c8/crates/topcoat/docs/tailwind.md)
- [graph-flow 0.6.0 on crates.io](https://crates.io/crates/graph-flow/0.6.0)
- [garde 0.23.0 documentation](https://docs.rs/garde/0.23.0/garde/)
- [Croner 3.0.1 documentation](https://docs.rs/croner/3.0.1/croner/)
- [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md)
- [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)

## License

MIT
