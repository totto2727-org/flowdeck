# Workflow Console Experiment

A local-only workflow dashboard built with Topcoat and graph-flow. It runs code-defined workflows manually or on cron schedules, keeps execution history in memory, and exposes node and edge traces for debugging and performance analysis.

## Usage

Open <http://127.0.0.1:3000/> after starting the server. Choose a workflow, enter its run arguments, and select **Run workflow**. Select any node or edge in the graph with a pointer, Enter, or Space to inspect its retained state, timing, output, error, and selected route.

The same state is available over HTTP:

```bash
curl -i http://127.0.0.1:3000/api/state
curl -i -X POST http://127.0.0.1:3000/api/runs \
  -H 'content-type: application/json' \
  --data '{"workflow_id":"demo-workflow","input":{"label":"local check","step_delay_ms":350}}'
```

## Key features

- Two code-defined workflows with branching, convergence, and observable sleep tasks.
- Manual arguments applied as the initial graph-flow context for each run.
- A code-defined cron schedule that uses the same in-memory execution service.
- SVG topology with active, traversed, and selected node and edge states.
- Per-node and per-edge traces with timestamps, elapsed time, state, output, and errors.

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
- [Topcoat getting started](https://github.com/tokio-rs/topcoat/blob/main/crates/topcoat/docs/getting_started.md)
- [graph-flow 0.6.0 on crates.io](https://crates.io/crates/graph-flow/0.6.0)
- [Croner 3.0.1 documentation](https://docs.rs/croner/3.0.1/croner/)
- [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md)
- [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)

## License

MIT
