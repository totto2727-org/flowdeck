# Workflow Console Experiment

## Language rules

- Use English for repository-recorded artifacts, including source code, configuration, documentation, and commit messages.
- Use Japanese for human-facing collaboration and handoff text.

## Repository structure

```text
src/                         Rust application, workflow engine integration, web routes, and browser assets
src/workflows/               Code-defined workflow registry, definitions, and shared tasks
tests/                       Rust integration tests and package-free Node browser lifecycle tests
Cargo.toml                   Rust package metadata, dependencies, and lint policy
rust-toolchain.toml          Rust 1.95 toolchain, rustfmt, Clippy, and rust-src
package.nix                  Installable Rust binary package
flake.nix                    Nix package, overlay, and development shell
Justfile                     Canonical development task entry points
.github/workflows/           CI and FlakeHub publication workflows
```

## Development commands

### Execution rules

- Run every command from the repository root.
- Enter the pinned environment with `nix develop` or allow `.envrc` with `direnv allow`.
- Use the `Justfile` tasks as the canonical command interface.
- Run `topcoat asset bundle` before starting the server. `topcoat-cli` is intentionally not part of the Nix package or development shell yet.
- The Nix package currently builds the Rust binary without the runtime Topcoat asset bundle; use `just run` for the complete local application surface.
- Keep FlakeHub publication changes scoped to `.github/workflows/flakehub-publish-rolling.yml` and the root flake.

### Standard tasks

- `just fix` — Format Rust code and apply Clippy fixes.
- `just check` — Check Rust formatting and lints, then syntax-check browser JavaScript.
- `just build` — Build with Cargo and Nix.
- `just test` — Run Rust integration tests and package-free Node tests.
- `just ci` — Run the complete local CI-equivalent suite.
- `just run` — Bundle Topcoat assets and start the loopback-only server.

## Architecture

### Workflow definitions

- `src/workflows.rs` is the shared registry imported by the application and web layers.
- Each workflow owns its definition below `src/workflows/<workflow>/definition.rs`.
- Run arguments become the initial graph-flow context before the first task executes.
- Manual and cron-triggered runs use the same workflow service and trace model.

### Execution state

- Workflow definitions, run history, scheduler state, and traces are process-local and in memory.
- Each observable task returns control after one graph-flow step so the current node and edge can be retained.
- Node and edge traces expose state, start and finish timestamps, duration, output or error, and route selection.

### Web surface

- Topcoat serves the dashboard and JSON API on `127.0.0.1:3000`.
- Browser JavaScript polls state, renders topology and history, and preserves accessible node and edge selection.
- Only the topology and history regions own horizontal overflow at narrow viewport widths.

### Packaging and automation

- `package.nix` builds the Cargo binary from `Cargo.lock` through `rustPlatform.buildRustPackage`.
- `flake.nix` exposes the default package, overlay, and a development shell containing rustup, Just, and Node.js 24.
- `.github/workflows/ci.yml` enters the flake environment and runs `just ci` for pull requests and pushes to `main`.
- `.github/workflows/flakehub-publish-rolling.yml` publishes the root flake as a public rolling release after pushes to `main`.

## Development tools

- **Rust and Cargo**: Build and test the server and workflow engine integration.
- **rustfmt and Clippy**: Enforce Rust formatting and lint policy.
- **Topcoat**: Render and serve the local dashboard and bundle browser assets.
- **graph-flow**: Execute the code-defined workflow graphs.
- **Node.js 24**: Syntax-check browser modules and run package-free lifecycle tests.
- **Nix flakes**: Pin the development environment and build the installable Rust package.
- **Just**: Provide the canonical local task interface used by CI.
- **direnv**: Load the default flake development shell from `.envrc`.
- **GitHub Actions and FlakeHub**: Validate the repository and publish rolling flake releases.

## Package-specific rules

- Keep the server bound to `127.0.0.1`; this project is local-only.
- Define workflows directly in Rust. Do not add a browser workflow editor without an explicit requirement.
- Keep run history and workflow state in memory until persistence is explicitly requested.
- Preserve workflow-owned input defaults and validate run input at the HTTP boundary.
- Preserve active, traversed, and selected graph states independently and keep trace details accessible by pointer and keyboard.
- Do not add Rig, OpenCode, or Codex integration until workflow execution requires them.

## Documentation

- [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md)
- [AGENTS template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/agents/template.md)
