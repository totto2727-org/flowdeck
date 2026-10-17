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
Build that image from the companion monorepo changes before using this integration.
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

`FLOWDECK_JCODE_MODEL` selects the SDK model, with `opencode/deepseek-v4.1-flash-free` as the current default.
Supply an approved `OPENCODE_API_KEY` through runtime configuration, not the image or the task prompt.
No host login directory is mounted or imported.
A missing or inaccessible model must fail instead of selecting another model.
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

Repository code and Jcode run as the same sandbox user.
The agent requires a model credential in its runtime environment, so this is not a security boundary against hostile repository code or malicious tasks.
Do not use this experiment for mutually untrusted tenants or sensitive host data.
Model-generated output is untrusted content and is not guaranteed to be free of secrets.
No Cloudflare deployment, DNS update, image publication, or Access policy change is performed by local startup.

## Verification status

The ARM64 sandbox base has run Jcode's API bridge under both Docker and Apple Container.
The bundled SDK gateway has started a real private Jcode bridge and answered its health endpoint under Docker without importing host credentials.
Its SDK `setModel` request reached Jcode with the exact `opencode:deepseek-v4.1-flash-free` selector and failed closed when no approved OpenCode credential was available.
No model turn was submitted in that isolated check.
The local Alchemy stack has built an ARM64-only experiment image and started a real Container from the development run Durable Object.
These observations do not establish successful model-driven implementation.
The maintained browser suite covers the development inputs on desktop and mobile without submitting a task, plus v1/v2 demo execution, checkpoint reload, and explicit resume.
The unit and real D1 tests cover development checkpoint ordering, duplicate submission prevention, session identity, and the six-hour lease with five-hour renewals.

The configured OpenCode credential import requires user approval.
Until that prerequisite is complete, real code editing, project test execution, and multi-turn continuity with the requested model remain unverified.
The AMD64 base-image build is also unverified: this macOS host's Ubuntu 26.04 emulation fails during archive extraction with `Function not implemented`.
A native Linux AMD64 builder must validate the normal Cloudflare image before deployment.
No production Cloudflare execution has been tested.

## Sources

- [Official Jcode installer](https://jcode.sh/install)
- [Official Jcode TypeScript SDK](https://github.com/1jehuang/jcode/tree/master/sdk/typescript)
- [Cloudflare native Container inactivity timeout](https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout)
- [Cloudflare sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)
