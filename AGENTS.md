# Flowdeck

## Scope and layout

This file serves contributors and maintainers.
Flowdeck is one private Vite+ application and one Alchemy project.
The application uses Effect 4, Effront, shadcn/ui, Cloudflare Workers, Durable Objects, and Kysely with a shared D1 database.

- `src/workers/frontend/`: Frontend entry, Access implementations, and frontend-only features.
- `src/workers/frontend/features/`: Effront pages, ServerFns, dashboard, graph, and shadcn components.
- `src/workers/control/`: Control entry and its HTTP routes, commands, and workflow-binding contract.
- `src/workers/demo-workflow/`: Workflow entry, run Durable Object, and demo-only execution features.
- `src/workers/development-workflow/`: development checkpoints, run Durable Object, and native Pi Container binding.
- `src/workers/inference/`: private Gateway-only credential and fixed HTTPS compatibility adapter.
- `containers/pi/`: private Effect HTTP gateway, directly embedded Pi SDK adapter, and workflow image.
- `src/features/development/`: shared session and turn receipt schemas.
- `src/workers/definitions.ts`: the single definition of Worker identities and contracts, shared by `.make()` implementations and static bindings.
- `src/workers/composition.ts`: final deployment and request dependency selection.
- `src/workers/database.ts`: the shared D1 resource declaration.
- `src/features/workflow/`: shared wire schemas, graph projection, and Kysely persistence.
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
The HTTPS inference transport does not require native AI binding preview access.
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
Use static service bindings only.
Keep the workflow entry point a thin router to a Durable Object stub.
Store the selected implementation version and immutable graph reference when a run is created.
Keep node definition identity separate from execution identity and retry attempt.
Persist state and events atomically with revision checks, and acknowledge only after commit.
Treat committed shared-DB state as canonical, not DO memory or pending promises.
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

Keep the migration limited to regular `@earendil-works/pi-coding-agent` 1.3.0 embedded in the existing Node Container gateway.
Do not add a Jcode executable, daemon, Container inference relay, Computer filesystem, Durable Object filesystem, or Pi Durable harness.
Preserve private port 8080, the session/turn receipt lifecycle, one session and checkout per run, and explicit resume.
Keep persisted workflow ID `jcode-development` and infrastructure resource name `JcodeSandbox` for compatibility.
Use **Pi development** for the frontend label.

Use `FLOWDECK_PI_MODEL`, Container `PI_MODEL` and `PI_INFERENCE_URL`, and `FLOWDECK_PI_DOCKERFILE` for configuration.
Route `http://flowdeck-inference/compat` through native `interceptOutboundHttp` and a static service binding to the private inference Worker.
Keep account and Gateway IDs and `Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY')` in the inference Worker.
Register that Gateway-only key as a native Worker `secret_text` binding, not an image or Container environment value.
Use one fixed HTTPS compatibility request with no runtime fallback or additional server.
Provider keys remain in Gateway stored BYOK, and Pi and the Container receive no inference credentials.
The generic published sandbox remains agent-neutral, and only the workflow image adds Node.js and Pi.
Keep `HOME=/home/sandbox` and checkout `/home/sandbox/workspace/project`.

When changing this integration, read [sandbox setup and acceptance limits](docs/development-sandbox.md).
When changing Container lifetime, read [workspace retention](docs/development-workflow-retention.md).
Local Pi implementation and explicit-resume verification passed in one Container, session, and checkout with operator-provisioned genuine frozen dependencies.
Do not describe this as unattended setup or count shim tests or no-cache CI as a normal cached CI pass.
Normal cached target CI still fails with `spawn EINVAL`, as tracked in [provisioning and cached tasks #14](https://github.com/totto2727-org/flowdeck/issues/14).
Use the [sandbox acceptance boundary](docs/development-sandbox.md#trust-and-acceptance-boundary) for the verified scope.
Track [credential isolation #10](https://github.com/totto2727-org/flowdeck/issues/10), [workspace-loss recovery #11](https://github.com/totto2727-org/flowdeck/issues/11), and [local Alchemy startup #12](https://github.com/totto2727-org/flowdeck/issues/12) separately from this migration.
Track native AI binding validation separately in [Issue #13](https://github.com/totto2727-org/flowdeck/issues/13).
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
