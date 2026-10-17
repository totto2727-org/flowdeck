# Flowdeck

Flowdeck combines code-defined workflow control with graph, state, and event inspection.
This version is an Effect-first Cloudflare application for local implementation experiments.

## Try the local application

This section serves users who want to run the demo locally.
Install Vite+, then run these commands from this repository:

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

## What is included

- One Alchemy project for all Workers and the shared D1 database.
- Effect HTTP for the Control API and Effect HttpClient over a static frontend service binding.
- Typed static RPC from Control to the workflow entry and its run-specific Durable Object.
- Kysely queries with D1 atomic state/event batches, revision checks, and duplicate-command receipts.
- Immutable run graphs, common shapes, and event projection by node and execution identity.
- Two bundled demo versions, typed checkpoints, and explicit recovery.
- Effront pages and ServerFns with shadcn Base UI components.
- A production Cloudflare Access declaration for `flowdeck.totto2727.dev`, with exact-email authorization and a trusted native runtime-context check.

## Scope and limits

The sample tasks are pure effects, not Container processes or remote jobs.
Container and Cloudflare Workflows nodes remain future workflow-owned integrations.
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

| Path                         | Responsibility                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workers/frontend/`      | Frontend entry and Access implementations. Its `features/` directory owns the dashboard, graph, Effront ServerFns, and UI components. |
| `src/workers/control/`       | Control entry. Its `features/` directory owns HTTP routes, run commands, and the workflow binding.                                    |
| `src/workers/demo-workflow/` | Workflow entry and run Durable Object. Its `features/` directory owns versioned demo transitions and node observation.                |
| `src/workers/composition.ts` | Select and inject deployment and authorization Layers. Infrastructure conditions exist only at this boundary.                         |
| `src/features/workflow/`     | Shared schemas, graph projection, database schema, and Kysely state/event persistence.                                                |

### Checks

```bash
vp run check
vp run test
vp run ci
vp run e2e
```

The browser acceptance suite starts the actual local Alchemy stack and exercises both versions at desktop and mobile sizes.
Use `vp run --no-cache e2e` when you need a fresh browser run instead of a cached task result.
Install the Playwright Chromium browser with `vp exec playwright install chromium` if it is not present.
Stop a manually started local stack before running the suite, which owns its server lifecycle.
Screenshots, traces, and reports remain under ignored `tmp/acceptance/`.
The test suite does not authorize a production deployment.

See [`AGENTS.md`](AGENTS.md) for Effect-first implementation rules and repository commands.
See [`docs/architecture.md`](docs/architecture.md) for persistence, versioning, recovery, security, and remaining implementation questions.
See [`SHADCN.md`](SHADCN.md) for the generated UI component sources and changes.

## License

MIT.
