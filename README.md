# Flowdeck

A local workflow cockpit for running, scheduling, and inspecting code-defined graph-flow workflows. Flowdeck keeps bounded execution history in memory, renders node and edge traces, and can use jcode as an optional coding-agent node.

## Usage

![Flowdeck showing a completed branching workflow, its topology, and execution history](./docs/images/flowdeck-workflow.png)

Start Flowdeck through one of the setup options, then open <http://127.0.0.1:3000/>. Choose a workflow, enter its run arguments, and select **Run workflow**. The completed run appears with its traversed route and chronological execution history; select a node or edge with a pointer, Enter, or Space to inspect retained state, timing, output, and errors.

Each run remains addressable at `/workflows/{workflow_id}/runs/{run_id}` while the server process is alive. Run-history filters are preserved in the URL, so reloads, bookmarks, and browser navigation restore the same server-rendered view without cookies.

## Key features

- Three code-defined workflows covering branching, linear review, and a complete jcode coding-agent turn.

- Workflow-owned forms whose data is deserialized by Serde, validated by garde, and applied as the initial graph-flow context.

- Multiple code-defined cron schedules with skip-while-running and allow-overlap policies.

- Process-wide concurrency, terminal-run retention, and workflow execution limits that bound in-memory and runtime work.

- Automatically laid out SVG topology with external self-loop routing and active, traversed, selected, and execution-count states.

- Per-execution node and edge traces with timestamps, elapsed time, state, output, errors, and exact `StepId` history.

- An optional jcode integration with one lazily started shared process and isolated or reusable named sessions.

- URL-addressable server-rendered run-history filtering with current-state SSE updates.

## Prerequisites

- **Nix**: Install Nix with flakes enabled on `aarch64-darwin`, `aarch64-linux`, or `x86_64-linux` to run or install the packaged application.

- **jcode**: Optional; required only for the `jcode-translation` workflow together with its provider credentials.

## Setup

### Run without installing

```bash
nix run github:totto2727-org/flowdeck
```

### Install

```bash
nix profile add github:totto2727-org/flowdeck
```

### Nix flake

```nix
{
  inputs.flowdeck.url = "github:totto2727-org/flowdeck";

  outputs = { flowdeck, ... }: {
    packages = flowdeck.packages;
  };
}
```

## API

This local application does not publish a stable external Rust API.

See [Flowdeck Architecture](./docs/architecture.md).
## Development

For repository structure and development commands, see [AGENTS.md](./AGENTS.md).

## License

MIT

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
