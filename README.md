# Flowdeck

A local workflow cockpit for running, scheduling, and inspecting code-defined workflows. Flowdeck helps you launch runs, follow their progress, explore workflow topology, review recent history, and inspect results from a local web interface.

## Usage

![Flowdeck showing a completed sample workflow, its topology, and execution history](./docs/images/flowdeck-workflow.png)

Start Flowdeck through one of the setup options, then open <http://127.0.0.1:3000/>. Choose a bundled sample, enter its run arguments, and select **Run workflow**. Follow the highlighted route as the run progresses, then select a step or transition with a pointer, Enter, or Space to inspect its status, timing, output, and errors.

The bundled workflows demonstrate the interface only. Application developers define concrete workflows in Rust and rebuild Flowdeck to register them. Flowdeck is local and non-persistent, so run history remains available only while the application is running.

## Key features

- Run code-defined workflows from a local web interface.
- Use a workflow-specific input form to enter and validate each run's arguments.
- Define recurring schedules and their skip-or-overlap policy in Rust for runs that would start while an earlier run is still active.
- Automatically laid out SVG topology with external self-loop routing and active, traversed, selected, and execution-count states.
- Per-execution node and edge traces with timestamps, elapsed time, state, output, errors, and exact `StepId` history.
- Review recent runs and keep selected history filters in bookmarkable URLs.
- Navigate workflow details with a pointer or keyboard.
- Add optional coding-agent steps, with jcode as one example.

## All Code

Flowdeck follows an **All Code** approach. Workflow structure, schedules, inputs, validation, and execution rules are explicit Rust code. Define the workflow you need, rebuild Flowdeck, and review every change through normal version control.

Flowdeck deliberately provides no low-code or no-code workflow layer, visual workflow editor, or configuration DSL. Runtime values such as provider settings and credentials remain external inputs, but they do not define the workflow. With modern AI-assisted development, low-code and no-code representations offer no meaningful advantage in either version control or implementation cost, so Flowdeck keeps workflow definitions in Rust to maximize extensibility, compiler-checked correctness, and runtime performance.

## Prerequisites

- **Nix**: Install Nix with flakes enabled on `aarch64-darwin`, `aarch64-linux`, or `x86_64-linux` to run or install the packaged application.

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

## Optional coding-agent setup

Only workflows that use the optional jcode integration need this setup. Install the revision validated by Flowdeck:

```bash
cargo install --git https://github.com/1jehuang/jcode --rev a63dbc4546895ecb4d1be1a285d98e6e13fb1b74 --locked jcode
```

Set `JCODE_BIN` to the installed executable, then follow the [GlossShift configuration guide](https://github.com/totto2727-org/glossshift/blob/66fad64044a49e22879fb5eceed0e9b19457fca3/README.md#configuration) to place `config.toml` and `credentials.toml` under `$XDG_CONFIG_HOME/glossshift` or `~/.config/glossshift`.

## API

Flowdeck currently exposes its supported interface through the local web application. It does not publish a stable external API.

## Development

For repository structure and development commands, see [AGENTS.md](./AGENTS.md).

## License

MIT

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
