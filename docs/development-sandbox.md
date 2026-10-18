# Pi development sandbox

This guide serves trusted operators and maintainers who run implementation and verification tasks in one workspace.
The official PiHarness integration has passed local project CI and browser validation.
Real coding validation has confirmed source changes, focused tests, and the built public export, but the complete implementation-to-verification workflow remains unverified.
This is a local experiment, not a production or multitenant execution service.

## Components

- The run Durable Object uses official `PiHarness` from `agents/harness/pi` and `Harness` from `@earendil-works/pi-durable` for durable conversation and operation execution.
- `@cloudflare/computer` Workspace owns the filesystem interface, with `ContainerBackend` for shell execution and official `createPiTools` declarations and dispatch installed in the pi-durable registry.
- `containers/workspace/Dockerfile` supplies official `computerd` 0.5.1 and repository tool prerequisites, not an embedded Pi SDK, custom HTTP runner, or inference proxy.
- `src/workers/development-workflow/` owns the run Durable Object, workspace integration, model configuration, checkpoints, and Container binding.
- The shared D1 database owns workflow identity, graph, checkpoints, and ordered events.
- Control reaches the private workflow Worker through a static service binding.

The persisted workflow ID `jcode-development` and infrastructure resource name `JcodeSandbox` remain unchanged for compatibility.
The frontend label is **Pi development**.
New runs use runtime `pi-harness`.
Legacy Jcode and direct Pi SDK histories remain available for inspection, but execution fails closed.
Create a new PiHarness run instead of resuming a legacy runtime.

## Local setup

Use the Node.js version pinned by Vite+, and start Docker before starting Flowdeck.
Use the standard Alchemy Cloudflare credentials when required.
Stop if authentication or permissions are missing and ask the operator to provide access.
Do not attempt to bypass these prerequisites.

The workspace Dockerfile accepts `ARG WORKSPACE_IMAGE`, defaulting to `ghcr.io/totto2727-org/monorepo/sandbox-dev:latest`.
It copies `/usr/local/bin/computerd` from `ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1`.
An alternate base must support the Dockerfile's runtime and `apt-get` installation of `fuse3`, `libfuse2t64`, and `ca-certificates`, together with the required FUSE operation.
This is a derived-image build, not a one-call guarantee for an arbitrary untouched image.
`FLOWDECK_WORKSPACE_IMAGE` optionally selects a prepared official-computerd-compatible image directly at resource composition.
When it is unset, Flowdeck builds the workspace Dockerfile, with `FLOWDECK_PI_DOCKERFILE` available as an alternate Dockerfile selector.
The prepared-image setting differs from the Dockerfile's `WORKSPACE_IMAGE` base argument.
Neither path supports an arbitrary untouched image without the backend runtime prerequisites.

The published generic sandbox supplies Git and Nix, but does not put Node.js or Vite+ directly on `PATH`.
Workflow-specific Node.js 24 and Corepack provisioning belong in the derived workspace image, not the generic base.
The target project's frozen dependencies supply local `vp`, not a globally installed Vite+ in the image.
Follow that repository's declared package manager and lockfile rather than assuming pnpm.
Repositories that require Bun or another runtime need it in their selected workflow image or development environment.
Use the target repository's `devShell` for its other development tools.
The generic image and package set are unchanged by this work.
A lightweight generic `sandbox-dev` tool inventory is deferred to [monorepo #384](https://github.com/totto2727-org/monorepo/issues/384).

Keep `HOME=/home/sandbox` and use `/workspace/project` as the checkout path through Computer Workspace.
The Container serves the official `computerd` backend on port 8080, not a custom session/turn HTTP gateway.
Keep its build context limited to `containers/workspace/`.

```bash
vp env install
vp install --frozen-lockfile
vp run dev
```

The frontend uses loopback port 4380 and the private development Worker uses loopback port 4383.
Select **Pi development**, enter a public GitHub repository and a task, then start a new run.
Explicit resume reads the harness operation result and advances to verification or completion.
Implementation and verification reuse the same run-scoped session and checkout.
The local implementation trial confirmed one run-scoped Container and checkout during editing and repeated explicit polling.
Implementation settlement and the subsequent verification turn remain unverified.

## Model and inference transport

The fixed model is `custom-opencode-go/deepseek-v4.1-flash` through Cloudflare AI Gateway.
The run Durable Object configures the official pi-ai provider with `cloudflareAIGatewayAuth` and `withOpenCodeSessionHeader` over its OpenAI completions API.
It calls the Gateway compatibility endpoint directly:

```text
https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/compat
```

Set `CLOUDFLARE_ACCOUNT_ID` and an explicit existing `CLOUDFLARE_AI_GATEWAY_ID` with stored BYOK configuration.
Flowdeck does not select or create a default Gateway.
`Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY')` is registered as a native Worker `secret_text` binding and used only by the run Durable Object.
The official provider resolves Gateway authentication inside that credential boundary.
Provider keys remain in Gateway stored BYOK.
There is no separate inference Worker, Container inference proxy, custom authorization transport, or runtime provider fallback.
The current path does not use a native AI binding.
A missing or inaccessible model must fail.

For an approved live task, provide the Gateway-only credential to Alchemy:

```bash
pass-cli exec cloudflare/account-id -- pass-cli exec cloudflare/ai-gateway-id -- pass-cli exec cloudflare/ai-gateway-api-key -- vp run dev
```

Do not pass inference credentials to Workspace tools, the Container environment, images, build arguments, logs, or task prompts.
Do not add dummy provider authorization headers or mount a host login directory.
This design has an application credential in the Durable Object, not a credential-free application.

## Session, operations, and workspace lifetime

Each run owns one Durable Object, one Computer Workspace with its Container backend, and one Pi root session.
Official `ROOT_SESSION = '1'` is scoped by that run Durable Object, not shared globally across runs.
PiHarness and pi-durable own durable conversation and operation state.
The workflow commits command identity before submitting it as a harness operation ID.
The workflow adapter maps harness submission, pending operations, and results to its session/turn receipt contract.
It does not implement a second Container-side receipt store or agent loop.
Durable operation state does not guarantee exactly-once external side effects or automatic restoration of lost shell work.

Official Lifecycle jobs renew the native six-hour Container inactivity timeout every five hours for unfinished runs while the Container is running.
Node transitions reuse the workspace rather than resetting the session.
Failed work remains available for inspection and can continue to incur charges.
Renewal does not advance workflow nodes or restart a stopped Container.
See [workspace retention](development-workflow-retention.md) for policy and operator cleanup.
Durable conversation and Workspace state do not establish recovery of all Container-local files or interrupted external effects.

## Trust and acceptance boundary

The Access-authorized frontend invokes the private Control path in a deployed application.
The agent loop and Gateway-only credential stay in the run Durable Object.
Repository code and shell tools execute in the Computer Container backend.
This separation is not evidence of tenant isolation, safe execution of hostile repositories, or protection against unauthorized inference charges.
Model output remains untrusted and can contain secrets.

Local Flowdeck validation passed normal cached CI with 125 tests and 14 desktop/mobile browser checks.
The real PiHarness task changed only the target function and focused tests through official Workspace tools.
In the same Container, an operator independently confirmed five focused tests, a direct `vp pack` build, and four cases through the built public export.
Dependency setup required operator assistance: the target repository used Bun, the temporary task requested pnpm, and Container dependency downloads failed.
Genuine frozen Linux dependencies were provisioned through a separate Docker helper and copied into the existing Container without changing its source or lockfile.
The normal cached target build failed with `spawn EINVAL`; direct build success does not establish normal target CI success.
The live implementation operation had not settled at the last observation, so the explicit verification turn is not validated.
Successful harness operation settlement also does not establish task acceptance: a model-reported blocker can still produce a completed workflow ([task acceptance #15](https://github.com/totto2727-org/flowdeck/issues/15)).
Earlier direct-SDK results do not validate the current runtime.
Five/six-hour retention, unattended dependency setup, production deployment, Access, and DNS have not been accepted.

Keep these concern links, with their scope reassessed under the current architecture:

- [Credential isolation #10](https://github.com/totto2727-org/flowdeck/issues/10): validate the Durable Object credential boundary and remaining abuse risks, not the removed inference proxy.
- [Workspace-loss recovery #11](https://github.com/totto2727-org/flowdeck/issues/11): establish Workspace and Container-loss recovery limits without assuming durable Pi history restores shell effects.
- [Local Alchemy startup #12](https://github.com/totto2727-org/flowdeck/issues/12): validate the current local stack and official runtime integration.
- [Native AI binding validation #13](https://github.com/totto2727-org/flowdeck/issues/13): a separate concern, not validation of the current pi-ai HTTPS Gateway provider.
- [Dependency provisioning and cached tasks #14](https://github.com/totto2727-org/flowdeck/issues/14): the current Container trial required operator-provisioned dependencies and reproduced `spawn EINVAL` in the normal cached target build.

The frontend build concern remains separate.
Local startup does not authorize deployment, DNS or Access changes, or image publication.

## Sources

- Official installed APIs: `agents/harness/pi`, `agents/lifecycle`, `@earendil-works/pi-durable`, `@cloudflare/computer`, and `@cloudflare/computer/tools/pi-ai`.
- Integration: the runtime entry, resource composition, `features/models.ts`, and `features/workspace.ts` under `src/workers/development-workflow/`.
- [Cloudflare Computer](https://github.com/cloudflare/computer)
- [Cloudflare AI Gateway stored BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Cloudflare Container inactivity timeout](https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout)
