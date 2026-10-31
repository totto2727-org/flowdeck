# Flowdeck

Flowdeck combines code-defined workflow control with graph, state, and event inspection.
This version is an Effect-first Cloudflare application for local implementation experiments.

## Try the local application

This section serves users who want to run the demo locally.
Install the official Vite+ CLI with `curl -fsSL https://vite.plus | bash`, then open a new shell before running the commands below.
Vite+ resolves Node.js and the package manager from this project's configuration; no Nix-managed JavaScript tools or separate Node.js setup are required.
For Pi inference, configure the existing Cloudflare account and Gateway ID and a Gateway-only key as described in the [sandbox guide](docs/development-sandbox.md#model-and-inference-transport).
The official pi-ai Gateway provider runs in the run Durable Object without a native AI binding or Container inference proxy.
Stop if required authentication or permissions are missing and ask the operator to provide access.

Run these commands from this repository:

```bash
vp env install
vp install --frozen-lockfile
vp run dev
```

Open <http://127.0.0.1:4380>.
Select `1.0.0` or `2.0.0` and start a run.
The first node completes and the run waits for manual approval.
Select graph nodes with the pointer, Tab and Enter, or arrow keys.
Inspect the committed snapshot and ordered events, then select **Resume run**.
Refresh the page to read the persisted run history.
If an interrupted run remains pending or running, select **Recover run** to load its committed checkpoint.

> [!NOTE]
> `engines.node` and `packageManager` in `package.json` define Node.js compatibility and the package-manager version.
> Vite+ resolves Node.js from the engine constraint without a separate `.node-version` file.
> A Vite+ session override takes precedence over the project settings.
> Run `vp env current` to inspect the selected version and its source.
> Run `vp env use --unset` to clear a stale session override and return to project settings.

Local development starts the frontend, private Control API, and private workflow Worker together.
The local Control API listens on port 4381 for development inspection.
These ports are bound to loopback, not the public network.
Stopping the runtime does not deliberately delete its local shared database.
A later explicit resume loads committed state rather than an in-memory continuation.

### Optional Pi development workflow

The official PiHarness integration has passed local CI and browser validation.
A live task completed implementation and explicit-resume verification in one Container and Pi session, with remaining environment and instruction-compliance limits.
Its run Durable Object owns durable conversation and operations through `agents/harness/pi` and `@earendil-works/pi-durable`.
It uses `@cloudflare/computer` Workspace with `ContainerBackend` and official `createPiTools` installed in the harness registry.
Implementation and verification reuse one run-scoped Pi root session and `/workspace/project`, with `HOME=/home/sandbox`.

`sandbox/Dockerfile` builds the Ubuntu 26.04 workspace with Nix, Home Manager, and the official `computerd` 0.5.1 binary.
It contains all three build targets: `nix`, `sandbox`, and final `workspace`.
The official binary is copied from `ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1`; the final image is not based on that scratch image.
The sandbox flake and custom package definitions live under `sandbox/nix/`, without a monorepo flake input.
Start local Pi development with `DOCKER_DEFAULT_PLATFORM=linux/amd64 vp run dev` for the x64 runtime.
Alchemy builds the complete workspace from the single Dockerfile; no separate Flowdeck base image build or publication is required.
See [sandbox image maintenance](sandbox/README.md) for optional intermediate build targets, source provenance, and validation limits.
Optional `FLOWDECK_WORKSPACE_IMAGE` selects a prepared official-computerd-compatible image instead of the Dockerfile build.
A prepared image must contain the runtime, shell, and FUSE prerequisites; an arbitrary untouched image is not supported.
The final workspace installs official Vite+ as `sandbox` under `/home/sandbox/.vite-plus` and supplies global `vp` on `PATH`.
Use the target repository's `vp env` configuration to resolve Node.js and package-manager versions; the image does not bake in fixed project versions.
Use `nix develop` or a minimal temporary `nix shell` only for required non-JavaScript tools, not for Vite+, Node.js, pnpm, Bun, or Deno.
The image does not install Deno directly; this does not imply that Vite+ manages Deno.
The original monorepo image is not modified.
Its lightweight tool inventory remains tracked in [monorepo #384](https://github.com/totto2727-org/monorepo/issues/384).

The fixed model is `custom-opencode-go/deepseek-v4.1-flash` through Cloudflare AI Gateway.
The official pi-ai provider uses `cloudflareAIGatewayAuth` and `withOpenCodeSessionHeader` in the run Durable Object.
`Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY')` is a native Worker `secret_text` binding used only by that Durable Object.
Provider keys remain in Gateway stored BYOK, and no inference credential is passed to Workspace tools or the Container.
This boundary does not establish tenant isolation or prevent unauthorized inference charges ([credential isolation #10](https://github.com/totto2727-org/flowdeck/issues/10)).
Do not put credentials in Git, images, build arguments, logs, or task prompts.
See the [sandbox setup and acceptance limits](docs/development-sandbox.md) before starting a live task.

## What is included

- One Alchemy project for all Workers and the shared D1 database.
- Effect HTTP for the Control API and Effect HttpClient over a static frontend service binding.
- One typed static RPC binding from Control to the `Workflow` integration Worker, which owns the catalog and routes to individual workflow Workers and their run-specific Durable Objects.
- Kysely queries with D1 atomic state/event batches, revision checks, and duplicate-command receipts.
- Immutable run graphs, common shapes, and event projection by node and execution identity.
- Two bundled demo versions, typed checkpoints, and explicit recovery.
- An official durable PiHarness integration with Computer Workspace tools and one run-scoped session and checkout for implementation and verification.
- Effront pages and ServerFns with shadcn Base UI components.
- A production Cloudflare Access declaration for `flowdeck.totto2727.dev`, with exact-email authorization and a trusted native runtime-context check.

## Scope and limits

The release-demo tasks are pure effects.
The separate Pi development workflow uses official PiHarness, pi-durable, and Computer Workspace rather than a Container-side agent gateway.
The workflow ID is `jcode-development` and the infrastructure resource name is `JcodeSandbox`.
Runs use runtime `pi-harness`; old direct-SDK snapshots and obsolete ID/version formats are not accepted.
Official `ROOT_SESSION = '1'` is scoped by the run Durable Object, not shared across runs.
Official Lifecycle jobs renew the six-hour native inactivity timeout every five hours for unfinished running workspaces without advancing workflow nodes or restarting stopped Containers.
See [workspace retention](docs/development-workflow-retention.md) for cost and recovery limits.
The local trial below preceded the official Vite+ provisioning change.
It completed both Pi turns and independently confirmed five tests, format/type/lint checks, a direct build, and five built public-export cases in a temporary `nix shell` in the same Container.
The normal cached target CI still failed with `spawn EINVAL`; Pi also used prohibited `--no-cache` flags, so policy-compliant acceptance remains incomplete.
Nix downloads required a Container-only DNS adjustment, and unattended setup and long-duration retention remain unverified.
Prior direct-SDK success and image smoke checks do not establish current end-to-end task acceptance.
See [sandbox setup and acceptance limits](docs/development-sandbox.md) for the current trust boundary and qualified concern links for [#10](https://github.com/totto2727-org/flowdeck/issues/10), [#11](https://github.com/totto2727-org/flowdeck/issues/11), [#12](https://github.com/totto2727-org/flowdeck/issues/12), [#13](https://github.com/totto2727-org/flowdeck/issues/13), and [#14](https://github.com/totto2727-org/flowdeck/issues/14).
Those issues require assessment under PiHarness, not transfer of previous-runtime results.
Native AI binding validation in #13 is separate from the current pi-ai HTTPS Gateway provider.
The frontend build concern also remains separate.
Cloudflare Workflows nodes remain a future workflow-owned integration.
The inspected Effect 4 releases do not contain the official Machine API referenced by the design.
The demo therefore uses a small workflow-owned tagged-state transition, not an official Machine integration or a new general-purpose engine.
External side-effect replay, dynamic workflow registration, generic runner protocols, artifact transfer, and old dependency reproducibility are not provided.
The run list and event history currently target a small local experiment, not unbounded production retention.

No cloud deployment, DNS change, or Access policy change is part of local startup.
The production stack requires an explicit nonempty `FLOWDECK_ACCESS_EMAILS` allowlist and standard Alchemy Cloudflare credentials.
The domain and Access declaration are not evidence that a production service is deployed or reachable.

## Development

This section serves contributors and maintainers.
The root Nix development shell supplies `nixfmt`, not JavaScript runtimes or package managers.

### Source layout

| Path                                | Responsibility                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workers/frontend/`             | Frontend entry and Access implementations. Its `features/` directory owns the dashboard, graph, Effront ServerFns, and UI components. |
| `src/workers/control/`              | Control entry. Its `features/` directory owns HTTP routes, run commands, and the workflow binding.                                    |
| `src/workers/demo-workflow/`        | Workflow entry and run Durable Object. Its `features/` directory owns versioned demo transitions and node observation.                |
| `src/workers/development-workflow/` | Development run, official PiHarness, Computer Workspace, model configuration, and implementation and verification checkpoints.        |
| `sandbox/`                          | Derived workspace image with official `computerd` and repository tool prerequisites.                                                  |
| `src/features/development/`         | Shared development session and turn receipt schemas.                                                                                  |
| `src/workers/composition.ts`        | Select and inject deployment and authorization Layers. Infrastructure conditions exist only at this boundary.                         |
| `src/features/workflow/`            | Shared schemas, graph projection, database schema, and Kysely state/event persistence.                                                |

### Checks

```bash
vp run check
vp run test
vp run ci
vp run e2e
```

The browser acceptance suite starts the actual local Alchemy stack and exercises both versions at desktop and mobile sizes.
Use `vp run e2e` for the browser suite, and use task caching by default for validation commands.
Install the Playwright Chromium browser with `vp exec playwright install chromium` if it is not present.
Stop a manually started local stack before running the suite, which owns its server lifecycle.
Screenshots, traces, and reports remain under ignored `tmp/acceptance/`.
The test suite does not authorize a production deployment.
CI uses the shared `setup-typescript` action and its `setup-vp` step to install Vite+ and resolve project versions.
Flowdeck CI does not need separate `setup-node`, Nix setup or evaluation, or forced Node.js and package-manager version inputs.

See [`AGENTS.md`](AGENTS.md) for Effect-first implementation rules and repository commands.
See [`docs/architecture.md`](docs/architecture.md) for persistence, versioning, recovery, security, and remaining implementation questions.
See [`SHADCN.md`](SHADCN.md) for the generated UI component sources and changes.

## License

MIT.
