# Flowdeck

Flowdeck runs code-defined workflows and displays their graphs, state, and events.
It is an experimental Cloudflare application.

## Usage

Open <http://127.0.0.1:4380> after [setup](#setup).

1. Select **Release checkpoint**, choose a version, and select **Start run**.
2. Select a graph node to inspect its state and events.
3. Select **Resume run** at manual approval to continue execution.
4. Refresh the page to read the saved run history.

For agent-assisted coding tasks, see [Pi development setup and limits](docs/development-sandbox.md).

## Key features

- Versioned workflows with immutable run graphs.
- Shared Effect Machine transitions and Effect tasks, with execution and visual graphs derived from one definition.
- Saved checkpoints, explicit resume, and recovery.
- Graph navigation and inspection of state and ordered events.
- A Pi development workflow for implementation and verification in one workspace.

## Prerequisites

| Requirement                                       | Purpose                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| [Official Vite+ CLI](https://viteplus.dev/guide/) | Resolve Node.js and the package manager from project settings.     |
| Alchemy Cloudflare credentials                    | Access the intended Cloudflare account.                            |
| Alchemy Cloudflare state store                    | Store remote deployment state; local development uses local state. |
| `FLOWDECK_ACCESS_POLICY_ID` for remote deployment | Reference the existing Pulumi-managed SAML Access policy.          |
| Published Reylo packages from the lockfile        | Analyze SQL imports against the HCL schema.                        |

Pi tasks also require Docker and configured inference access.
See the [Pi prerequisites](docs/development-sandbox.md) before starting a task.

## Setup

Clone the repository and enter its directory:

```sh
git clone https://github.com/totto2727-org/flowdeck.git
cd flowdeck
vp env install
vp install --frozen-lockfile
```

Complete the [local setup](docs/database.md#local-analysis-and-checks), then start the application:

```sh
vp run dev
```

> [!IMPORTANT]
> Remote deployment can create or update Alchemy's Cloudflare state store.
> Confirm the target account and authorize any required state-store setup before deploying.
> Changing the backend does not transfer existing local infrastructure state.

Remote deployment attaches the existing `allowSaml` policy from [Pulumi's Cloudflare definitions](https://github.com/totto2727-org/monorepo/blob/main/infra/cloudflare/src/access-policy.ts).
Set `FLOWDECK_ACCESS_POLICY_ID` to that policy's deployed ID, not the SAML group or identity-provider ID.
Alchemy owns the Flowdeck Access application, not the shared policy or group.
The deployment composition selects one complete `DevelopmentLayer` or `ProductionLayer` from `src/workers/application.ts`.
Both Layers assemble the same Worker implementation graph, with fixed dependencies for their environment.
The Effront runtime uses a separate fixed capture assembly so it does not provision sibling Workers or recreate the Access application.
Request assembly decodes the native audience binding and injects a typed expected audience into the same authorization logic in every environment.
Local development supplies a fixed audience and identity through Alchemy's `dev.access` without an authorization bypass.

## Automatic production deployment

[Deploy production](.github/workflows/deploy.yml) is separate from [CI](.github/workflows/ci.yml).
It runs only after successful push CI on `main` in this repository and checks out that run's exact `head_sha`.
Pull request CI does not deploy, and there are no preview deployments.
The workflow must be present on the default branch before `workflow_run` can trigger it.
Production deployments share one non-cancelling concurrency group; GitHub can replace older pending runs, so this is not a FIFO release queue.

Configure these settings in the GitHub `production` environment before enabling deployment:

| Kind     | Name                            | Purpose                                                                                                                                           |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variable | `CLOUDFLARE_ACCOUNT_ID`         | Intended Cloudflare account.                                                                                                                      |
| Variable | `CLOUDFLARE_AI_GATEWAY_ID`      | Explicit existing AI Gateway with configured stored BYOK.                                                                                         |
| Variable | `FLOWDECK_ACCESS_POLICY_ID`     | Existing Pulumi-managed `allowSaml` policy ID.                                                                                                    |
| Secret   | `CLOUDFLARE_API_TOKEN`          | Alchemy provisioning access for the application's Workers, D1, Containers/images, Access application/domain, and official Cloudflare state store. |
| Secret   | `CLOUDFLARE_AI_GATEWAY_API_KEY` | Gateway authentication, deployed as the development workflow Worker's secret binding.                                                             |

Credentials are supplied only to the deploy step, not dependency installation or CI.
Use environment protection rules to control production authorization.
Before the first approved run, confirm the account, official Cloudflare state-store availability, any required migration from local state, and sufficient token permissions.
The existing `alchemy.run.ts` selects the official remote backend; the workflow does not replace it or migrate state.
Alchemy's `--yes` authorizes the application update and any required state-store setup, so do not enable the workflow before operator approval.

The hosted Linux runner must provide Docker with Buildx and sufficient disk and time for the full `sandbox/Dockerfile` build.
Alchemy builds the `sandbox` context for `linux/amd64`, including its Nix/Home Manager provisioning and official computerd runtime, then publishes the Container image.
No separate base-image publication, host Nix setup, registry login step, or inference credential build argument is required.
The workflow intentionally does not select a prepared-image or Dockerfile override.
The shared monorepo `deploy-alchemy` action is not used because it evaluates a root Nix shell and expects a `{ url }` stack output, whereas Flowdeck uses the Reylo SQL loader and returns `{ frontend }`.
Dependency installation keeps the frozen lockfile and repository release-age/build-script safeguards.

## Reference

| Guide                                                         | Contents                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Pi development](docs/development-sandbox.md)                 | Task inputs, credentials, workspace setup, and acceptance limits.      |
| [Workspace retention](docs/development-workflow-retention.md) | Workspace lifetime, costs, and recovery limits.                        |
| [Workflow graphs](docs/workflow-graphs.md)                    | Graph definitions, execution, versioning, checkpoints, and recovery.   |
| [RPC boundaries](docs/rpc-boundaries.md)                      | Error conversion, origin logging, Result codecs, and RFC 9457 details. |

## Development

For repository maintenance, commands, and implementation rules, see [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).
