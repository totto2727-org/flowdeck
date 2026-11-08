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
| Unpublished Reylo HCL support                     | Analyze this branch's SQL imports; see the warning below.          |

> [!WARNING]
> The declared registry packages do not yet include the required Reylo HCL support.
> A registry-only installation cannot currently start this branch.
> For a temporary local trial, follow [local fork validation](docs/database.md#local-analysis-and-checks).

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

## Reference

| Guide                                                         | Contents                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Pi development](docs/development-sandbox.md)                 | Task inputs, credentials, workspace setup, and acceptance limits. |
| [Workspace retention](docs/development-workflow-retention.md) | Workspace lifetime, costs, and recovery limits.                   |

## Development

For repository maintenance, commands, and implementation rules, see [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).
