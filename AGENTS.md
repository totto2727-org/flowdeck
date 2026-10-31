# Flowdeck

## Scope and layout

This file serves contributors and maintainers.
Flowdeck is one private Vite+ application and one Alchemy project.
The application uses Effect 4, Effront, shadcn/ui, Cloudflare Workers, Durable Objects, and Reylo SQL queries with a shared D1 database.

- `src/workers/frontend/`: Frontend entry, Access implementations, and frontend-only features.
- `src/workers/frontend/features/`: Effront pages, ServerFns, dashboard, graph, and shadcn components.
- `src/workers/control/`: Control entry and HTTP routes, with one static binding to the integration Worker.
- `src/workers/workflow/`: Workflow integration entry, catalog, run commands, and fixed per-workflow bindings.
- `src/workers/demo-workflow/`: Workflow entry, run Durable Object, and demo-only execution features.
- `src/workers/development-workflow/`: development checkpoints, run Durable Object, official PiHarness, and Computer Workspace integration.
- `sandbox/`: workspace image with the official `computerd` runtime.
- `src/workers/development-workflow/features/model.ts`: development-owned session and turn receipt schemas.
- `src/workers/definitions.ts`: lightweight Worker identities and contracts for `.make()` implementations and static bindings, with only a type re-export of `DevelopmentWorkflow` to keep infrastructure out of the frontend runtime graph.
- `src/workers/development-workflow/index.ts`: the sole external `DevelopmentWorkflow` definition, with native Durable Object exports from `worker.ts` through official Alchemy support, not custom `props.exports`.
- `src/workers/composition.ts`: final deployment and request dependency selection.
- `src/workers/database.ts`: the shared D1 resource declaration.
- `src/features/workflow/`: shared wire schemas, graph projection, typed SQL persistence, and the `Workflows` service contract.
- `schema/schema.hcl`: Atlas-managed SQLite tables, constraints, and indexes.
- `src/features/workflow/services/queries/`: one Reylo-typed SQL statement per file.
- `migrations/`: maintained D1 schema migrations.
- `alchemy.ts` and `alchemy.run.ts`: all application resources in one project.
- `vite.config.ts`: canonical development and validation tasks.
- `tmp/`: ignored experiment output and temporary review evidence.

## Commands

Run commands from this repository root with Vite+.
Install the official Vite+ CLI locally with `curl -fsSL https://vite.plus | bash` before using these commands.
Let Vite+ resolve Node.js and the package manager from the target project's configuration.
Do not manage Vite+, Node.js, pnpm, Bun, or Deno with Nix.
Do not install Deno directly in the Flowdeck image or assume that Vite+ manages Deno.
The root Nix development shell supplies only non-JavaScript tools, currently `nixfmt`.
Use `vp env install` to resolve Node.js from `engines.node` and the package manager from `packageManager` in `package.json`.
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
Use `Schema.isUUID(4)`, `Schema.URLFromString`, and `Schema.SemVerFromString` instead of custom identity, URL, or version parsers.
Keep ideal domain values independent from their serialized representation.
Use official codecs at persistence and transport boundaries, including `Schema.SemVer` internally and its JSON/string codecs at those boundaries.
Use `Schema.DateTimeUtc` for internal timestamps and the official codecs for serialized ISO timestamps.
Use the shared `JsonObject` schema for JSON snapshots and event payloads, not repeated unrestricted record schemas.
Model each event kind with a discriminated union: node execution fields are required where applicable and absent otherwise.
This application is unreleased: do not add backward-compatibility unions, legacy normalization, or fallback identity formats.
Do not validate URLs with regular expressions.
Use ordinary string operations for business constraints after parsing.
Use a regular expression only when no suitable existing API or simple string operation fits, and document the specific reason beside it.
Represent state differences with tagged unions, not optional properties.
An optional property may represent genuinely optional metadata, but its presence must not select a system state or execution path.
Use a simple `if` when it is clearer, but do not introduce `for` loops or `switch` statements.
Name non-obvious numeric constants at module scope in the owning file instead of embedding magic numbers in calculations.
Create a separate constants file only when multiple files share the values.
Use Effect HttpClient for HTTP clients and Effect HTTP for API routing and responses.
Use native Request, Response, Promise, and Cloudflare binding interfaces only in the smallest adapters required by the runtime or a typed library.
Document each unavoidable interoperability boundary.
Compose dependencies with Context services and Layers at entry points.
Keep workflow effects independent from deployment configuration.
Select infrastructure-specific implementations only when injecting dependencies at the final composition boundary.
Do not branch on development flags, deployment stages, or infrastructure phases inside feature logic or request authorization.
Keep Worker-specific features with their Worker, and put shared features under `src/features/`.
Use Atlas HCL for SQLite tables, constraints, and indexes, with versioned SQL migrations consumed by Alchemy.
Keep SQLite correctness triggers in reviewed migrations because Atlas Community does not model triggers.
Use Reylo Content Mapper SQL imports for typed queries, not handwritten table interfaces or a query builder.
Keep schema analysis local: Reylo reads `schema/schema.hcl` directly through the fork's HCL schema source, without Atlas preparation or database files.
Reylo evaluates HCL through Atlas and analyzes the schema in memory.
Use Atlas CLI tasks only for migration creation and validation with `--dev-url "sqlite://dev?mode=memory"`, never `schema apply` or a file-backed development database.
Use `vp run check` for complete TypeScript 7.1 Content Mapper checking plus Vite+ format and type-aware lint.
Vite+'s independent TypeScript 7.0 checker cannot load Content Mappers, so it is not the application's full type checker.
Keep receipt, state, and event writes in one native D1 batch using Reylo's public Standard Query `text` and `encode` contract.
Do not add a custom SQL compiler or batch-binding patch; see [database workflow](docs/database.md).

## Workflow invariants

Keep one Worker per workflow and one logical Durable Object ID per run.
Use the additional `Workflow` integration Worker as Control's only workflow service binding.
Keep catalog, initial run persistence, and per-workflow routing in that Worker, not in Control.
Treat each workflow as an independent application module.
Keep workflow IDs, supported versions, input schemas, initial snapshots, and graphs in that workflow's own feature files.
The shared `WorkflowDefinition` and `WorkflowExecutor` interfaces contain no individual workflow knowledge.
Compose workflow-provided definitions and static bindings only in `src/workers/workflow/features/registration.ts`.
The integration service and frontend consume that registry and its catalog mechanically, without workflow-specific branches.
Workflow versions are official `SemVer` values internally and strings only at explicit persistence and transport codecs.
Use static service bindings only.
Keep the workflow entry point a thin router to a Durable Object stub.
Store the selected implementation version and immutable graph reference when a run is created.
Keep node definition identity separate from execution identity and retry attempt.
Use `UserDefinedId` for caller-defined identifiers and `makePrefixedUUIDv4(prefix)` for app-owned random identifier schemas from `src/features/identity/id.ts`.
Infer each ID type from its Schema, without brands or duplicate handwritten types.
`makePrefixedUUIDv4(prefix)` returns `{ schema, make }`; define each named Schema and Crypto-backed factory in the feature that owns the identifier.
Do not add a central ID-kind registry or a `randomId(kind)` dispatcher.
Use timestamps and indexed sequence columns for ordering, not UUIDv7 or time embedded in an ID.
Keep framework-owned session, operation, and resource identity contracts distinct from application-generated IDs.
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
Use Tailwind utilities and components for application styling.
Keep `features/styles/app.css` limited to Tailwind imports and shadcn theme tokens and base configuration.
Do not add application-specific selectors or global component styles there.
Do not write application-specific raw CSS when Tailwind utilities or normal components can express it.
For a structurally unavoidable exception, document its purpose, why standard alternatives cannot satisfy the requirement, why the chosen solution is appropriate, and its exact scope beside the implementation.
An undocumented exception is not permitted; documenting one makes it reviewable, not automatically approved.
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
Use workflow ID `jcode-development` and infrastructure resource name `JcodeSandbox`; neither is a random identity.
Use **Pi development** for the frontend label.
Runs use runtime `pi-harness`; do not accept legacy direct-SDK histories.
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
Install official Vite+ in the final workspace stage as `sandbox`, with `VP_HOME=/home/sandbox/.vite-plus` and `VP_NODE_MANAGER=yes`.
Keep its `bin` directory on `PATH`; the workspace supplies global `vp`.
Do not bake fixed project Node.js or package-manager versions into the image.
Use the target project's `vp env` configuration to resolve them, and preserve its declared package manager and lockfile.
Use `nix develop` or a minimal temporary `nix shell` only for required non-JavaScript tools.
Nix's internal Bun build dependency for the existing oo and Monid packages is separate from user-facing Bun management.
Run computerd and repository tools as `sandbox`, with `HOME=/home/sandbox` and checkout `/workspace/project` through Computer Workspace.
Do not modify the original monorepo images for Flowdeck-specific requirements.
The original generic image's lightweight tool inventory remains tracked in [monorepo #384](https://github.com/totto2727-org/monorepo/issues/384).

Read [sandbox setup and acceptance limits](docs/development-sandbox.md) before changing this integration and [workspace retention](docs/development-workflow-retention.md) before changing lifetime behavior.
Use official Lifecycle jobs to renew the six-hour native inactivity timeout every five hours without advancing workflow nodes or restarting stopped Containers.
A real PiHarness run completed both implementation and explicit-resume verification in the same Container and root session.
Before the official Vite+ provisioning change, independent temporary-Nix checks passed five tests, format/type/lint checks, direct build, and five built public-export cases.
Normal cached target CI still fails with `spawn EINVAL`, and Pi used prohibited `--no-cache` flags, so full policy-compliant acceptance remains incomplete.
Do not transfer direct-SDK results, operation completion, or cache-disabled checks into a claim of normal target CI success.
Track [credential isolation #10](https://github.com/totto2727-org/flowdeck/issues/10), [workspace-loss recovery #11](https://github.com/totto2727-org/flowdeck/issues/11), [local Alchemy startup #12](https://github.com/totto2727-org/flowdeck/issues/12), [native AI binding validation #13](https://github.com/totto2727-org/flowdeck/issues/13), and [dependency provisioning and cached tasks #14](https://github.com/totto2727-org/flowdeck/issues/14) as concerns requiring assessment under this architecture, not as evidence of its acceptance.
Native AI binding validation is separate from the current pi-ai HTTPS Gateway provider.
Keep the frontend build concern separate as well.

## Validation and artifacts

Keep CI JavaScript setup in the shared `setup-typescript` action, which delegates to `setup-vp`.
Do not add separate `setup-node`, Nix setup or evaluation, or forced JavaScript version inputs to Flowdeck CI.
Follow the workspace coding and test skills.
Apply every skill in the workspace's DietrichGebert/ponytail skill set when reviewing changes, and record inapplicable checks with a reason.
Use observable tests for version pinning, commit/ACK ordering, conflicts, duplicate events, graph projection, and recovery after runtime replacement.
Keep maintained tests and design documentation in Git.
Keep one-off reports, external skill checkouts, screenshots, and experiment output under ignored `tmp/`.
Keep code, repository documents, and commit messages in English.
Use Japanese for collaboration and final handoff.
Preserve `CLAUDE.md` as the relative alias to this file.
