# Flowdeck

Flowdeck combines code-defined workflow control with graph, state, and event inspection.
This version is an Effect-first Cloudflare application for local implementation experiments.

## Try the local application

This section serves users who want to run the demo locally.
Install Vite+ before running the commands below.
For Pi inference, configure the existing Cloudflare account and Gateway ID and a Gateway-only key as described in the [sandbox guide](docs/development-sandbox.md#model-and-inference-transport).
The HTTPS inference transport does not require native AI binding preview access.
Stop if required authentication or permissions are missing and ask the operator to provide access.

Run these commands from this repository:

```bash
vp env install
vp install --frozen-lockfile
vp run dev
```

Open <http://127.0.0.1:4380>.
Select v1 or v2 and start a run.
The first node completes and the run waits for manual approval.
Select graph nodes with the pointer, Tab and Enter, or arrow keys.
Inspect the committed snapshot and ordered events, then select **Resume run**.
Refresh the page to read the persisted run history.
If an interrupted run remains pending or running, select **Recover run** to load its committed checkpoint.

> [!NOTE]
> `.node-version` pins Node.js 24.19.0.
> A Vite+ session override takes precedence over the project pin.
> Run `vp env current` to inspect the selected version and its source.
> Run `vp env use --unset` to clear a stale session override and return to project pins, or `vp env use 24.19.0` to select that version for the session.

Local development starts the frontend, private Control API, and private workflow Worker together.
The local Control API listens on port 4381 for development inspection.
These ports are bound to loopback, not the public network.
Stopping the runtime does not deliberately delete its local shared database.
A later explicit resume loads committed state rather than an in-memory continuation.

### Optional Pi development workflow

Local Pi coding acceptance passed with operator-provisioned dependencies, not as an unattended setup.
The workflow image embeds `@earendil-works/pi-coding-agent` 1.3.0 directly in a Node.js process on the published generic `sandbox-dev` image.
The generic sandbox does not preinstall Node.js, Pi, pnpm, or Vite+.
Use the target repository's `devShell` for its development tools.
Implementation and verification share one Pi session and `/home/sandbox/workspace/project` with `HOME=/home/sandbox`.

The default model is `custom-opencode-go/deepseek-v4.1-flash` through Cloudflare AI Gateway.
Pi sends OpenAI-compatible requests to a private inference Worker through native Container HTTP interception and a static service binding.
That Worker sends one fixed HTTPS compatibility request to AI Gateway using a Gateway-only key.
Provider credentials remain in Gateway stored BYOK, and no inference credential is passed to Pi or the Container.
This credential boundary does not prevent unauthorized inference charges or isolate hostile repository code ([credential isolation #10](https://github.com/totto2727-org/flowdeck/issues/10)).
Do not put credentials in Git, images, build arguments, logs, or task prompts.
See the [sandbox setup and acceptance limits](docs/development-sandbox.md) before starting a live task.

## What is included

- One Alchemy project for all Workers and the shared D1 database.
- Effect HTTP for the Control API and Effect HttpClient over a static frontend service binding.
- Typed static RPC from Control to the workflow entry and its run-specific Durable Object.
- Kysely queries with D1 atomic state/event batches, revision checks, and duplicate-command receipts.
- Immutable run graphs, common shapes, and event projection by node and execution identity.
- Two bundled demo versions, typed checkpoints, and explicit recovery.
- A workflow-owned Pi Container integration that reuses one SDK session and checkout for implementation and verification.
- Effront pages and ServerFns with shadcn Base UI components.
- A production Cloudflare Access declaration for `flowdeck.totto2727.dev`, with exact-email authorization and a trusted native runtime-context check.

## Scope and limits

The release-demo tasks are pure effects.
The separate Pi development workflow uses the normal Container filesystem and a private HTTP session/turn receipt gateway on port 8080.
It does not require Cloudflare Computer, a Durable Object filesystem, or Pi Durable.
The persisted workflow ID `jcode-development` and infrastructure resource name `JcodeSandbox` remain unchanged for compatibility.
Implementation and explicit-resume verification completed in the same Container, Pi session, and checkout with the requested model.
The operator supplied genuine frozen dependencies, and normal cached target CI still fails with `spawn EINVAL` ([provisioning and cached tasks #14](https://github.com/totto2727-org/flowdeck/issues/14)).
Independent real-tool checks passed, but shim tests and no-cache CI are not evidence of a normal cached CI pass.
See [sandbox setup and acceptance limits](docs/development-sandbox.md) for the model, credentials, trust boundary, and recovery limits.
Track [workspace-loss recovery #11](https://github.com/totto2727-org/flowdeck/issues/11), [local Alchemy startup #12](https://github.com/totto2727-org/flowdeck/issues/12), and [native binding validation #13](https://github.com/totto2727-org/flowdeck/issues/13) separately from this migration.
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

### Source layout

| Path                                | Responsibility                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workers/frontend/`             | Frontend entry and Access implementations. Its `features/` directory owns the dashboard, graph, Effront ServerFns, and UI components. |
| `src/workers/control/`              | Control entry. Its `features/` directory owns HTTP routes, run commands, and the workflow binding.                                    |
| `src/workers/demo-workflow/`        | Workflow entry and run Durable Object. Its `features/` directory owns versioned demo transitions and node observation.                |
| `src/workers/development-workflow/` | Development run, native Container binding, and workflow-specific implementation and verification checkpoints.                         |
| `src/workers/inference/`            | Private Worker with the Gateway-only credential and fixed HTTPS compatibility adapter.                                                |
| `containers/pi/`                    | Container-side Effect HTTP gateway, embedded Pi SDK adapter, and image definition.                                                    |
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

See [`AGENTS.md`](AGENTS.md) for Effect-first implementation rules and repository commands.
See [`docs/architecture.md`](docs/architecture.md) for persistence, versioning, recovery, security, and remaining implementation questions.
See [`SHADCN.md`](SHADCN.md) for the generated UI component sources and changes.

## License

MIT.
