# Pi development sandbox

This guide serves trusted operators and maintainers who run implementation and verification tasks in one sandbox.
Local Pi coding acceptance passed with operator-provisioned dependencies.
This is not an unattended setup guarantee.
This is a local experiment, not a production or multitenant execution service.

## Components

- The published `ghcr.io/totto2727-org/monorepo/sandbox-dev:latest` image supplies the generic Nix sandbox.
- The workflow image in `containers/pi/` adds Node.js and `@earendil-works/pi-coding-agent` 1.3.0.
- The Node process embeds the regular Pi SDK directly and serves the private Effect HTTP gateway on Container port 8080.
- `src/features/development/` defines the shared session and turn receipt schemas.
- `src/workers/development-workflow/` owns checkpoints, the run Durable Object, and the native Alchemy Container binding.
- `src/workers/inference/` owns the Gateway-only credential and fixed HTTPS compatibility adapter.
- Control reaches the workflow Worker through a static service binding.

There is no Jcode executable, daemon, or Container-side inference relay.
There is no Cloudflare Computer filesystem, Durable Object filesystem, or Pi Durable harness.
Pi tools use the Container's normal filesystem and shell.
The persisted workflow ID `jcode-development` and infrastructure resource name `JcodeSandbox` remain unchanged for compatibility.
The frontend label is **Pi development**.

## Local setup

Use the Node.js version pinned by Vite+, and start Docker before starting Flowdeck.
The HTTPS inference transport does not require native AI binding preview access.
Use the standard Alchemy Cloudflare credentials when required.
Stop if authentication or permissions are missing and ask the operator to provide access.
Do not attempt to bypass these prerequisites.
The generic sandbox does not preinstall Node.js, Pi, pnpm, or Vite+.
Only the workflow image adds its Node.js runtime and Pi dependency.
Use the target repository's `devShell` for its development tools.

The workflow image derives from the published generic sandbox image.
Its Dockerfile accepts `SANDBOX_BASE` for a direct image build.
Use a base with `HOME=/home/sandbox`.
The gateway and tools run as `sandbox` and share `/home/sandbox/workspace/project`.
Gateway receipts and session data stay under `/home/sandbox/.flowdeck`.

```bash
vp env install
vp install --frozen-lockfile
vp run dev
```

The `dev` task builds the gateway bundle before Alchemy builds its Container image.
Keep the image build context and file watcher limited to `containers/pi/` to avoid restarts caused by Alchemy's changing state.
The frontend uses loopback port 4380 and the private development Worker uses loopback port 4383.
Select **Pi development**, enter a public GitHub repository and a task, then start a run.
Explicit resume reads the accepted turn receipt and advances to verification or completion.
A waiting run does not start a second Pi session.

## Model and inference transport

`FLOWDECK_PI_MODEL` selects the same model for the private inference Worker and the Container's `PI_MODEL`.
The default is `custom-opencode-go/deepseek-v4.1-flash` through Cloudflare AI Gateway.
`FLOWDECK_PI_DOCKERFILE` selects an alternate Dockerfile at infrastructure composition.
Neither setting changes workflow transitions or authorization.

The Container receives `PI_MODEL` and `PI_INFERENCE_URL=http://flowdeck-inference/compat`, not inference credentials.
Pi sends OpenAI-compatible requests to that endpoint.
Native `interceptOutboundHttp('flowdeck-inference', serviceBinding)` routes them to the private inference Worker.
That Worker sends a single HTTPS request to the fixed Gateway endpoint:

```text
https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/compat/chat/completions
```

The Worker adds `cf-aig-authorization: Bearer <gateway-key>` from its own secret binding.
Provider credentials remain in Gateway stored BYOK.
The adapter fixes the endpoint and configured model.
It forwards only a validated UUID `x-opencode-session` value and discards caller authorization headers.
There is no runtime transport fallback, provider fallback, Container relay, or additional server.
A missing or inaccessible model must fail.
Do not add dummy provider authorization headers or mount a host login directory.

Set `CLOUDFLARE_ACCOUNT_ID` and an explicit existing `CLOUDFLARE_AI_GATEWAY_ID` with stored BYOK configuration.
Flowdeck does not select or create a default Gateway.
For an approved live task, provide the Gateway-only credential to Alchemy:

```bash
pass-cli exec cloudflare/account-id -- pass-cli exec cloudflare/ai-gateway-id -- pass-cli exec cloudflare/ai-gateway-api-key -- vp run dev
```

Only the inference Worker reads `Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY')` and registers it as a native Worker `secret_text` binding.
The key is not passed to Pi, the Container environment, images, or build arguments.
Do not put credentials in Git, logs, or task prompts.
This design has an application credential in the Worker, not a credential-free application.
Native AI binding validation for this custom model and stored BYOK is tracked separately in [Issue #13](https://github.com/totto2727-org/flowdeck/issues/13).

## Session, receipts, and workspace lifetime

Each run owns one Durable Object, one native Container, and one Pi session.
Implementation and verification reuse that session and checkout.
The session belongs to the gateway process, not an individual HTTP request.
The private HTTP contract retains `/health`, `/session`, `/turns`, `/turns/:commandId`, and `/complete`.

The shared database stores workflow identity, graph, checkpoints, and ordered events.
The workflow commits command identity before submission.

The gateway persists a receipt before starting a turn and returns while it runs.
An exact retry returns the existing receipt.
Conflicting command content, concurrent work, and work on a completed session are rejected.
A running receipt becomes interrupted after a gateway restart and is not automatically resubmitted.
These safeguards do not guarantee exactly-once external effects.

A retention alarm refreshes the native six-hour inactivity timeout every five hours until completion.
Failed work remains available for inspection and can continue to incur charges.
See [workspace retention](development-workflow-retention.md) for alarm behavior and operator cleanup.
Retention is not durable filesystem storage.
A platform failure, runtime shutdown, or replacement can lose the writable checkout and Pi session files.
The persisted startup marker prevents automatic Container replacement.
Filesystem snapshots and automatic recovery are outside this migration.
Track additional recovery requirements in [workspace-loss recovery #11](https://github.com/totto2727-org/flowdeck/issues/11) instead of adding another filesystem layer here.

## Trust and acceptance boundary

The Access-authorized frontend invokes the private Control path in a deployed application.
The gateway validates bounded requests, and its build context excludes host configuration and credentials.
Provider diagnostics are not returned as HTTP error bodies.

Pi, repository code, and the gateway run as the same user.
The inference Worker holds the Gateway-only key and keeps inference credentials out of Pi and the Container.
Provider credentials remain in Gateway stored BYOK.
Local checks found no inference credential environment variables or Pi `auth.json` in the Container ([credential isolation #10](https://github.com/totto2727-org/flowdeck/issues/10)).

Pi tools can still request inference and incur unauthorized charges.
This is not an isolation boundary for untrusted tenants or sensitive host data.
Model output remains untrusted and can contain secrets.

Local acceptance completed implementation and explicit-resume verification with `custom-opencode-go/deepseek-v4.1-flash` through the Worker's HTTPS transport.
Both nodes used the same Container, Pi session, and project checkout.
Only two files changed: the expected source file and its test.
Package metadata, lockfile, Bun configuration, Nix flake, and target documentation were unchanged.

The operator provisioned genuine dependencies from an ordinary Linux AMD64 builder with Bun 1.3.13 and the unchanged frozen dependency policy.
Those dependencies were copied into the same Container before real verification.
This acceptance does not establish unattended dependency setup.
Shim-based tests are excluded from the evidence.
See [dependency provisioning and cached tasks #14](https://github.com/totto2727-org/flowdeck/issues/14).

Independent checks in that Container passed real Vite+ format, lint, and type checks and five Vitest tests.
JavaScript and declaration builds and a five-file package dry-run passed.
Six assertions against the built public export also passed.
Normal cached target `vp run ci` still fails with `spawn EINVAL`, which the owner independently reproduced.
The Pi agent also reported the same failure on the unmodified baseline.
A model-reported no-cache CI result is not a normal cached CI pass, and no cache-disabling workaround was added.

The current endpoint-only workflow image passed the canonical AMD64 Alchemy build and actual Pi execution.
Flowdeck's ordinary CI passed 181 tests, and its current HTTP stack passed all 14 real browser tests.
These checks do not validate production deployment, Cloudflare Access, or DNS.
Track [local Alchemy startup #12](https://github.com/totto2727-org/flowdeck/issues/12) and the separate frontend build concern outside this migration.
Local startup does not deploy Cloudflare resources, change DNS or Access, or publish an image.

## Sources

- [Pi coding agent SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [Cloudflare AI Gateway REST requests](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Cloudflare AI Gateway OpenAI provider](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)
- [Cloudflare AI Gateway stored BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Cloudflare Container inactivity timeout](https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout)
