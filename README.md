# Workflow Console Experiment

A local-only workflow dashboard built with Topcoat, Datastar, Tailwind CSS, and graph-flow. It runs code-defined workflows manually or on cron schedules, keeps execution history in memory, and exposes node and edge traces for debugging and performance analysis.

## Usage

Open <http://127.0.0.1:3000/> after starting the server. The root redirects to the first code-defined workflow. Choose a workflow, enter its run arguments, and select **Run workflow**. Select any node or edge in the graph with a pointer, Enter, or Space to inspect its retained state, timing, output, error, and selected route.

Workflow selection starts at `/workflows/{workflow_id}`. When that workflow has retained runs, the server redirects this abbreviated URL to its newest exact `/workflows/{workflow_id}/runs/{run_id}` path. A workflow with no runs redirects to its exact `/workflows/{workflow_id}/runs/` path, which renders the workflow topology without a step trace or run inspector. Reloading or bookmarking an exact run path restores the same in-memory run while the server process remains alive. Unknown workflows, runs, and paths return an HTTP 404 recovery page and then return through `/` to the first workflow and its newest run.

The server emits `tracing` events for its listening URL and completed HTTP requests. Set `RUST_LOG=workflow_console_experiment=info` to enable these application logs when a broader environment filter is already configured.

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

- Two code-defined workflows with branching, convergence, and observable sleep tasks.
- Workflow-owned forms whose data is deserialized by Serde, validated by garde, and applied as the initial graph-flow context.
- A code-defined cron schedule that uses the same in-memory execution service.
- SVG topology with active, traversed, and selected node and edge states.
- Per-node and per-edge traces with timestamps, elapsed time, state, output, and errors.
- URL-addressable server-rendered run-history filtering with separate run and history SSE streams.

## Architecture

### Feature boundaries

The web surface is organized by feature. Each feature keeps its transport entrypoint next to the component or fragment that it updates, so an SSE endpoint can be traced to its rendered target without crossing a horizontal `web`/`web_page` split.

No `mod.rs` files are used. Self-named module files such as `features.rs`, `run_detail.rs`, and `component.rs` only declare child modules and expose the minimum feature entrypoints; rendering, transport, and state logic lives in the named child modules.

| Feature | API boundary | Component and fragment boundary |
| --- | --- | --- |
| `workflow_launcher` | `POST /actions/runs` in `features/workflow_launcher/action.rs` | `features/workflow_launcher/component.rs` owns the workflow selector, workflow-owned input form, and run action surface. |
| `run_detail` | `GET /events/runs/{run_id}` in `features/run_detail/sse.rs` | `component/inspector.rs` composes the selected run or runless view; `workflow_graph.rs` renders the graph panel; `step_trace.rs` renders trace details; `component/topology/renderer.rs` renders SVG and `geometry.rs` computes node and edge geometry; `fragments.rs` produces the SSE patch. |
| `run_history` | `GET /events/history` in `features/run_history/sse.rs` | `component.rs` owns the panel; `fragments.rs` renders rows and empty state; `filter.rs` parses and normalizes URL filters; `membership.rs` derives insert, replace, and remove transitions. |

The module tree is intentionally feature-oriented and uses Rust self-named module files instead of `mod.rs`:

```text
src/
├── app.rs
├── app/
│   ├── routes.rs       # SSR routes and canonical redirects
│   ├── navigation.rs   # workflow and run URL construction
│   ├── page.rs         # document and initial signal composition
│   ├── console.rs      # feature component composition
│   └── document.rs     # 404 document layout
├── features.rs         # feature declarations and shared presentation exports
└── features/
    ├── workflow_launcher.rs
    ├── workflow_launcher/
    │   ├── action.rs
    │   └── component.rs
    ├── run_detail.rs
    ├── run_detail/
    │   ├── sse.rs
    │   ├── fragments.rs
    │   ├── component.rs
    │   └── component/
    │       ├── inspector.rs
    │       ├── workflow_graph.rs
    │       ├── step_trace.rs
    │       ├── topology.rs
    │       └── topology/
    │           ├── renderer.rs
    │           └── geometry.rs
    ├── run_history.rs
    └── run_history/
        ├── sse.rs
        ├── component.rs
        ├── fragments.rs
        ├── filter.rs
        └── membership.rs
```

The `app` module owns SSR routes, navigation, document/page composition, and feature assembly. It does not own feature-specific SSE or patch rendering. This keeps `run_detail` as the owner of both the run SSE and the graph/trace components, including the static graph shown when no run is selected.

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
- [Topcoat Tailwind integration](https://github.com/tokio-rs/topcoat/blob/371c7403fcbf4d40bbacb2f87eb98d9ce00e76c8/crates/topcoat/docs/tailwind.md)
- [graph-flow 0.6.0 on crates.io](https://crates.io/crates/graph-flow/0.6.0)
- [garde 0.23.0 documentation](https://docs.rs/garde/0.23.0/garde/)
- [Croner 3.0.1 documentation](https://docs.rs/croner/3.0.1/croner/)
- [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md)
- [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)

## License

MIT
