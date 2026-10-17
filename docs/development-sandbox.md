# Jcode development sandbox

This integration serves a trusted operator who wants to run an implementation task and its checks in one sandbox.
It is a local development experiment, not a production or multitenant execution service.

## Components

- The monorepo `sandbox-dev` image extends the official Jcode and Nix installation in `sandbox-base` with its Nix-managed development tools.
- `containers/jcode/` adds Node.js and an Effect HTTP gateway that uses the official `@1jehuang/jcode-sdk` package.
- `src/workers/development-workflow/` owns the versioned `jcode-development` workflow, its run Durable Object, and its native Alchemy Container binding.
- Control reaches this Worker through a static service binding.
  Neither this Worker nor its gateway has a public URL.
- The frontend offers a public GitHub repository URL and a task prompt.
  Both implementation and verification use `/sandbox/workspace/project`.

All Workers, the shared D1 database, and the Container belong to the same Alchemy project.
The Effront runtime evaluates its frontend-only entry instead of evaluating other Workers and their Container providers.

## Local setup

Use the Node.js version pinned by Vite+, and start Docker before starting Flowdeck.
The sandbox development image must contain the official Jcode installation and its Node.js, pnpm, and Vite+ tools.
Build that image from the companion [monorepo pull request #383](https://github.com/totto2727-org/monorepo/pull/383) before using this integration.
The gateway Dockerfile accepts `SANDBOX_BASE` when building an image directly.
Its normal default is `ghcr.io/totto2727-org/monorepo/sandbox-dev:latest`.
Do not assume an older published image contains Jcode.

```bash
vp env install
vp install --frozen-lockfile
vp run dev
```

The `dev` task builds the gateway bundle before Alchemy builds its Container image.
Both the image build context and Alchemy's file watcher are limited to `containers/jcode/`.
Watching the repository root would include Alchemy's own changing state and repeatedly restart an active sandbox.
It starts the frontend on loopback port 4380 and the private development Worker on loopback port 4383.
Use the frontend to select **Jcode development**, enter a public GitHub repository and a task, and start a run.
Use explicit resume to read the accepted turn receipt and advance to verification or completion.
A waiting run does not start a second agent session.

## Gateway model and runtime credentials

`FLOWDECK_JCODE_MODEL` selects the model, with `custom-opencode-go/deepseek-v4.1-flash` as the current default.
Requests use the configured Cloudflare AI Gateway, not a direct OpenCode provider key or a free-model route.
A missing or inaccessible model must fail instead of selecting another model.

The Gateway compatibility endpoint is `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/compat/chat/completions`.
This OpenCode Go route requires both `cf-aig-authorization: Bearer <gateway-key>` and an `x-opencode-session` header.
The SDK adapter preserves this contract through an Effect HTTP relay at `127.0.0.1:8081/v1/chat/completions`.
Jcode 0.98.1 cannot send the required custom headers directly to this Gateway host.
Its generated provider profile targets `http://127.0.0.1:8081/v1` and contains no Gateway credential.
The relay accepts only `POST /v1/chat/completions` and the exact configured model.
It sends requests to the fixed HTTPS Gateway endpoint and adds the authorization header and a persisted UUID `x-opencode-session` value.
Incoming URLs and headers cannot select another upstream, replace the credential, or change the model.
The workflow gateway on private Container port 8080 does not expose the inference route.
There is no automatic model or provider fallback.

For an approved live model experiment, inject the configured services with nested positional `pass-cli exec` commands:

```bash
pass-cli exec cloudflare/account-id -- pass-cli exec cloudflare/ai-gateway-id -- pass-cli exec cloudflare/ai-gateway-api-key -- vp run dev
```

Use the positional service names exactly as shown.
The hierarchical `--set` and `--from` forms are not supported by the inspected `pass-cli` version.
The nested command has successfully supplied the required runtime configuration.

| Runtime variable                | Purpose                                          |
| ------------------------------- | ------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`         | Account that owns the configured Gateway.        |
| `CLOUDFLARE_AI_GATEWAY_ID`      | Existing Gateway identifier.                     |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Token authorized for the selected Gateway route. |

Alchemy reads these values through Init-phase `Config.String` and `Config.Redacted` effects.
These reads register native Worker `secret_text` bindings.
The Worker resolves the bindings and passes the values to `Container.env` at runtime.
The local binding path has been checked, but no production secret registration or deployment has been performed.
Do not put credential values in Git, image layers, Docker build arguments, logs, or task prompts.
No host login directory is mounted or imported.

`FLOWDECK_JCODE_DOCKERFILE` can select an alternate Dockerfile at the infrastructure composition boundary for a local image experiment.
It does not change workflow transitions or authorization.

## Session and workspace lifetime

Each run has one Durable Object, one native Container instance, and one SDK session.
The implementation and verification nodes reuse that session and the same project checkout.
The SDK client belongs to the gateway process, not an individual HTTP request.
Completing a gateway session does not delete its files.

Native Cloudflare Containers can stop when their Durable Object becomes inactive, even if an agent is still running inside the Container.
A retention alarm refreshes the native six-hour inactivity timeout every five hours until the work is complete.
Failed work remains available for inspection rather than being treated as completed work.
Retaining a live Container can incur charges in a deployed environment.
See [workspace retention](development-workflow-retention.md) for alarm behavior, failure retention, operator cleanup, and the test boundary.

Retention is not durable filesystem storage.
A platform failure, local runtime shutdown, or runtime replacement can still stop a Container and lose its writable filesystem.
A persisted start-attempt marker prevents automatic replacement after such a stop.
Recovery then fails visibly instead of silently cloning a new workspace or repeating an accepted command.
This experiment does not implement filesystem snapshots, artifact transfer, or automatic disaster recovery.

## Checkpoints and acknowledgments

The shared database holds workflow identity, graph, checkpoint state, and ordered events.
The workflow commits a command identity before submitting work.
The gateway persists a command receipt before calling the SDK and returns promptly, while the accepted turn runs in the gateway's process scope.
An exact command retry returns its existing receipt.
A reused command ID with different content, concurrent work, or a completed session is rejected.

On restart, a previously running receipt becomes interrupted.
It is not automatically submitted again, because the original daemon or external effect may have continued after a connection failure.
An SDK stream ending without `turn_done` is not accepted as successful completion.
These safeguards do not promise exactly-once external side effects.

## Security boundary

Only the Access-authorized frontend can invoke the private Control path in a deployed application.
The gateway accepts bounded, schema-validated requests over its private Container port.
Its image build context excludes host configuration, credentials, Git metadata, and unrelated workspace files.
Provider diagnostics are not returned as HTTP error bodies.

Repository code, Jcode, and the gateway process run as the same sandbox user.
Only the gateway process needs the Gateway token for its outbound authorization header.
The SDK launch overrides `CLOUDFLARE_AI_GATEWAY_API_KEY` with an empty string for Jcode and its tool children.
This prevents ordinary inheritance of that token value, not all access from processes with the same user identity.
The loopback relay does not authenticate its local caller.
Same-user process access, including process metadata access where permitted, is not an isolation guarantee.
Do not treat this arrangement as a security boundary against hostile repository code or malicious tasks.
Do not use this experiment for mutually untrusted tenants or sensitive host data.
Model-generated output is untrusted content and is not guaranteed to be free of secrets.
No Cloudflare deployment, DNS update, image publication, or Access policy change is performed by local startup.

## Verification status

The ARM64 sandbox base has run Jcode's API bridge under both Docker and Apple Container.
The bundled SDK gateway has started a real private Jcode bridge and answered its health endpoint under Docker without importing host credentials.
Earlier isolated SDK bridge checks failed closed without an approved provider credential and did not submit a model turn.
The local Alchemy stack has built an ARM64-only experiment image and started a real Container from the development run Durable Object.
A direct request to `custom-opencode-go/deepseek-v4.1-flash` through the Gateway returned HTTP 200 and the expected answer `5`.
This direct probe verified Gateway inference and its authentication path before the SDK experiment.
A subsequent local SDK-driven task against `totto2727-org/template-vite-plus-lib` completed both implementation and explicit-resume verification with the requested model.
Run `543af008-2599-42a1-8e8c-92631d9e30d6` reached `completed` with ten committed events.
Both turns used SDK session `session_retriever_1792257461408_1213c0683a874745` and Container `f2c69360700d`.
The Container ID, start time, and image were unchanged before and after verification.
Only `src/greet.ts` and `src/greet.test.ts` changed in the target checkout.
The lockfile, release-age policy, and `package.json` remained unchanged.
An independent operator check in the same Container passed `vp run --no-cache ci`, including check, five tests, build, and pack dry-run.
Five assertions against the built public export also passed.
These are local target-project results, not evidence of a production deployment or a successful Flowdeck frontend build.
The maintained browser suite covers the development inputs on desktop and mobile without submitting a task, plus v1/v2 demo execution, checkpoint reload, and explicit resume.
The unit and real D1 tests cover development checkpoint ordering, duplicate submission prevention, session identity, and the six-hour lease with five-hour renewals.
Scoped SDK and relay tests cover the fixed upstream, mandatory headers, stable transport identity, exact-model rejection, and removal of the token from Jcode's launch environment.
These scoped tests complement the live repository task but do not establish generic recovery or exactly-once external execution.

The registry's IPv6 path failed during dependency installation in this experiment.
The model created a temporary IPv4-only CONNECT proxy at `127.0.0.1:8899` in sandbox scratch space, after which installation succeeded without changing repository networking configuration.
This proxy is an experiment-specific workaround, not a maintained source feature or an automatic Flowdeck networking guarantee.
Future runs must validate registry connectivity independently.
Flowdeck's frontend `vp build` issue remains unresolved and is separate from the target project's successful build.
The AMD64 base-image build is also unverified: this macOS host's Ubuntu 26.04 emulation fails during archive extraction with `Function not implemented`.
A native Linux AMD64 builder must validate the normal Cloudflare image before deployment.
No production Cloudflare execution has been tested.

## Sources

- [Official Jcode installer](https://jcode.sh/install)
- [Official Jcode TypeScript SDK](https://github.com/1jehuang/jcode/tree/master/sdk/typescript)
- [Jcode 0.98.1 named-provider request handling](https://github.com/1jehuang/jcode/blob/1c7426eb1/crates/jcode-provider-openrouter-runtime/src/lib.rs#L1321-L1369)
- [Jcode 0.98.1 OpenCode session headers](https://github.com/1jehuang/jcode/blob/1c7426eb1/crates/jcode-provider-openrouter-runtime/src/request_headers.rs#L47-L78)
- [Cloudflare AI Gateway REST requests](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Cloudflare AI Gateway custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Cloudflare native Container inactivity timeout](https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout)
- [Cloudflare sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)
