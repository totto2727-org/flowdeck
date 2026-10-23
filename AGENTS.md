# Flowdeck

## Scope and layout

This file serves contributors and maintainers.
Flowdeck is one private Vite+ application and one Alchemy project.
The application uses Effect 4, Effront, shadcn/ui, Cloudflare Workers, Durable Objects, and Kysely with a shared D1 database.

- `src/workers/frontend/`: Frontend entry, Access implementations, and frontend-only features.
- `src/workers/frontend/features/`: Effront pages, ServerFns, dashboard, graph, and shadcn components.
- `src/workers/control/`: Control entry and HTTP routes, with one static binding to the integration Worker.
- `src/workers/workflow/`: Workflow integration entry, catalog, run commands, and fixed per-workflow bindings.
- `src/workers/demo-workflow/`: Workflow entry, run Durable Object, and demo-only execution features.
- `src/workers/development-workflow/`: development checkpoints, run Durable Object, official PiHarness, and Computer Workspace integration.
- `sandbox/`: workspace image with the official `computerd` runtime.
- `src/features/development/`: shared session and turn receipt schemas.
- `src/workers/definitions.ts`: lightweight Worker identities and contracts for `.make()` implementations and static bindings, with only a type re-export of `DevelopmentWorkflow` to keep infrastructure out of the frontend runtime graph.
- `src/workers/development-workflow/index.ts`: the sole external `DevelopmentWorkflow` definition, with native Durable Object exports from `worker.ts` through official Alchemy support, not custom `props.exports`.
- `src/workers/composition.ts`: final deployment and request dependency selection.
- `src/workers/database.ts`: the shared D1 resource declaration.
- `src/features/workflow/`: shared wire schemas, graph projection, Kysely persistence, and the `Workflows` service contract.
- `migrations/`: maintained D1 schema migrations.
- `alchemy.ts` and `alchemy.run.ts`: all application resources in one project.
- `vite.config.ts`: canonical development and validation tasks.
- `tmp/`: ignored experiment output and temporary review evidence.

## Commands

Run commands from this repository root with Vite+.
Use `vp env install` to install the versions pinned by `.node-version` and `packageManager`.
Use `vp env current` to inspect resolution and `vp env use --unset` to clear stale session overrides.
Use `vp install --frozen-lockfile` to install the locked dependencies.
Use `vp run dev` for the local Alchemy application, `vp run check` for format and typed lint, `vp run test` for tests, and `vp run ci` for the complete configured checks.
Use the standard Alchemy Cloudflare credentials when required.
Set `CLOUDFLARE_AI_GATEWAY_ID` to an explicit existing Gateway ID, not a default or automatically created Gateway.
Pi inference runs in the run Durable Object through the official pi-ai Gateway provider, not a Container proxy or native AI binding.
Stop on missing authentication or permissions instead of trying to bypass them.
The local development server must bind to loopback.
Do not deploy, change DNS, or change Access policies without operator authorization.

## Effect-first implementation

Write Effect programs, not imperative TypeScript with Effect wrappers.
Use Effect Array, String, Record, Match, Schema, Clock, and collection APIs instead of equivalent standard-library APIs.
Use a simple `if` when it is clearer, but do not introduce `for` loops or `switch` statements.
Use Effect HttpClient for HTTP clients and Effect HTTP for API routing and responses.
Use native Request, Response, Promise, and Cloudflare binding interfaces only in the smallest adapters required by the runtime or a typed library.
Document each unavoidable interoperability boundary.
Compose dependencies with Context services and Layers at entry points.
Keep workflow effects independent from deployment configuration.
Select infrastructure-specific implementations only when injecting dependencies at the final composition boundary.
Do not branch on development flags, deployment stages, or infrastructure phases inside feature logic or request authorization.
Keep Worker-specific features with their Worker, and put shared features under `src/features/`.
Use Kysely for typed database queries.
Compile queries at the D1 batch adapter when a native atomic batch is required.
Do not replace Kysely with a second query layer.

## Workflow invariants

Keep one Worker per workflow and one logical Durable Object ID per run.
Use the additional `Workflow` integration Worker as Control's only workflow service binding.
Keep catalog, initial run persistence, and per-workflow routing in that Worker, not in Control.
Use static service bindings only.
Keep the workflow entry point a thin router to a Durable Object stub.
Store the selected implementation version and immutable graph reference when a run is created.
Keep node definition identity separate from execution identity and retry attempt.
Persist state and events atomically with revision checks, and acknowledge only after commit.
Treat committed shared-DB workflow state as canonical, not DO memory or pending promises.
The official PiHarness owns durable conversation and operation state in its Durable Object storage.
Make recovery explicit and workflow-owned.
Never promise generic replay or exactly-once external side effects.
Do not introduce a generic runner protocol, artifact store, or a custom general-purpose state-machine engine.
Effect 4 currently has no official Machine module in the inspected releases.
Keep the demo checkpoint transitions workflow-specific and identify official Machine integration as unresolved until a compatible API exists.

## Frontend and infrastructure

Use Effront and the shadcn Base UI components referenced in `SHADCN.md`.
Keep canonical data on the server and client state limited to selections, drafts, and operation feedback.
Preserve independent active, traversed, and selected graph states with pointer and keyboard access.
Use `flowdeck.totto2727.dev` as the public frontend domain.
Keep Control API and workflow Workers private, with public `workers.dev` endpoints and previews disabled.
Declare Cloudflare Access with the public frontend in the same Alchemy project.
Production access must fail closed without an explicit allow policy.
Local development does not modify Cloudflare resources.

## Pi development integration

Use the official `PiHarness` from `agents/harness/pi` with `@earendil-works/pi-durable` `Harness` in the run Durable Object.
The harness owns durable conversation and operation execution; D1 owns workflow checkpoints and events.
Use `@cloudflare/computer` Workspace with `ContainerBackend` and install `createPiTools` declarations and dispatch through the official pi-durable registry.
Do not embed the Pi SDK, a custom HTTP runner, or an inference proxy in the Container.
The Container runs official `computerd` and repository tools, not the agent loop.
Preserve one session and checkout per run, with explicit workflow resume.
Keep persisted workflow ID `jcode-development` and infrastructure resource name `JcodeSandbox` for compatibility.
Use **Pi development** for the frontend label.
New runs use runtime `pi-harness`; legacy direct-SDK histories remain inspectable but fail closed on execution.
Use official `ROOT_SESSION = '1'`, scoped by the run Durable Object, not a global session ID.

Keep the fixed model `custom-opencode-go/deepseek-v4.1-flash` in the Durable Object's official pi-ai provider configuration.
Use `cloudflareAIGatewayAuth` and `withOpenCodeSessionHeader` rather than a custom transport.
Keep `Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY')` as a native Worker `secret_text` binding, used only by the run Durable Object.
Provider keys remain in Gateway stored BYOK.
Do not pass inference credentials to Workspace tools, Container environment, images, build arguments, or task prompts.

Keep all image stages in `sandbox/Dockerfile`, with `ubuntu:26.04` as the operating-system base.
Use stage `nix` for Nix installation, `sandbox` for Home Manager provisioning, and final stage `workspace` for FUSE prerequisites and the official computerd binary.
Copy `/usr/local/bin/computerd` from `ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1`; do not copy the provisioned root filesystem into the official scratch image.
Keep the standalone flake and custom package definitions under `sandbox/nix/`, without monorepo flake inputs or local sibling dependencies.
Do not restore a monorepo overlay dependency.
Use `build:nix` and `build:sandbox` to build the corresponding targets from this Dockerfile with `sandbox/` as the context.
For the x64 workspace, use `DOCKER_DEFAULT_PLATFORM=linux/amd64` when building images or starting local Alchemy development.
The final workspace build includes both provisioning stages; it does not require separately built or published Flowdeck base images.
Keep the generic base tasks architecture-neutral.
Keep Vite+ task caching disabled for `build:nix` and `build:sandbox`, while retaining Docker's layer cache.
These tasks produce Docker daemon images, not cache-restorable repository files.
See [sandbox image maintenance](sandbox/README.md) for provenance, build targets, and validation limits.
Keep Alchemy's workspace context at `sandbox`, not the repository root.
Set optional `FLOWDECK_WORKSPACE_IMAGE` only to a prepared official-computerd-compatible image at resource composition.
Otherwise build the workspace Dockerfile, with `FLOWDECK_PI_DOCKERFILE` available as a Dockerfile override.
There is no `WORKSPACE_IMAGE` Dockerfile base argument.
A prepared image must contain the official runtime, shell, and FUSE prerequisites; this is not support for an arbitrary untouched image.
Do not bake Node.js or a package manager into the workspace image.
Use the target repository's `nix develop`, or a minimal temporary `nix shell`, for required development tools.
Do not claim that the image supplies global Vite+; the target project's frozen pnpm dependencies supply local `vp`.
Run computerd and repository tools as `sandbox`, with `HOME=/home/sandbox` and checkout `/workspace/project` through Computer Workspace.
Do not modify the original monorepo images for Flowdeck-specific requirements.
The original generic image's lightweight tool inventory remains tracked in [monorepo #384](https://github.com/totto2727-org/monorepo/issues/384).

Read [sandbox setup and acceptance limits](docs/development-sandbox.md) before changing this integration and [workspace retention](docs/development-workflow-retention.md) before changing lifetime behavior.
Use official Lifecycle jobs to renew the six-hour native inactivity timeout every five hours without advancing workflow nodes or restarting stopped Containers.
A real PiHarness run completed both implementation and explicit-resume verification in the same Container and root session.
Independent temporary-Nix checks passed five tests, format/type/lint checks, direct build, and five built public-export cases.
Normal cached target CI still fails with `spawn EINVAL`, and Pi used prohibited `--no-cache` flags, so full policy-compliant acceptance remains incomplete.
Do not transfer direct-SDK results, operation completion, or cache-disabled checks into a claim of normal target CI success.
Track [credential isolation #10](https://github.com/totto2727-org/flowdeck/issues/10), [workspace-loss recovery #11](https://github.com/totto2727-org/flowdeck/issues/11), [local Alchemy startup #12](https://github.com/totto2727-org/flowdeck/issues/12), [native AI binding validation #13](https://github.com/totto2727-org/flowdeck/issues/13), and [dependency provisioning and cached tasks #14](https://github.com/totto2727-org/flowdeck/issues/14) as concerns requiring assessment under this architecture, not as evidence of its acceptance.
Native AI binding validation is separate from the current pi-ai HTTPS Gateway provider.
Keep the frontend build concern separate as well.

## Validation and artifacts

Follow the workspace coding and test skills.
Apply every skill in the workspace's DietrichGebert/ponytail skill set when reviewing changes, and record inapplicable checks with a reason.
Use observable tests for version pinning, commit/ACK ordering, conflicts, duplicate events, graph projection, and recovery after runtime replacement.
Keep maintained tests and design documentation in Git.
Keep one-off reports, external skill checkouts, screenshots, and experiment output under ignored `tmp/`.
Keep code, repository documents, and commit messages in English.
Use Japanese for collaboration and final handoff.
Preserve `CLAUDE.md` as the relative alias to this file.
