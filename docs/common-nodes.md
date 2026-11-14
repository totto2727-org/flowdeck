# Common workflow nodes

Common nodes are Effect services called from ordinary native Machine invokes.
They do not introduce another graph interpreter or choose workflow transitions.
The workflow owns its input, node names, prompts, result handling, checkpoints, and recovery decisions.
See [Add a workflow](add-workflow.md) for registration and [workflow graphs](workflow-graphs.md) for execution and persistence.

## PiHarness with two workspace backends

Both backends run official `PiHarness` and pi-durable in the run Durable Object.
The choice changes the workspace and shell, not the location of the agent loop.
Separate runtime definitions keep Container provisioning out of DO-only workflows.

| Capability                      | Container workspace                                        | DO-only Worker shell                                            |
| ------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Runtime constructor             | `makePiSdk`                                                | `makeWorkerShellPiSdk(options)`                                 |
| Context service                 | `PiSdk`                                                    | `PiWorkerShellSdk`                                              |
| Agent execution                 | PiHarness in the run Durable Object                        | PiHarness in the run Durable Object                             |
| Workspace backend               | Official Computer `ContainerBackend` and computerd         | Official `WorkerShellBackend` and `ShellWorker`                 |
| Shell environment               | Provisioned Linux Container                                | Official just-bash shell in the same isolate                    |
| Workspace persistence           | Computer Workspace with the Container-backed checkout      | Computer Workspace SQLite in the host Durable Object            |
| Required compute bindings       | Container                                                  | Neither Container nor Worker Loader                             |
| Shell network access            | Container backend uses direct egress                       | Disabled by `egress: { mode: 'none' }` and the shell fetch hook |
| Linux tools, Node.js, and Vite+ | Supplied by the prepared workspace image and project setup | Not equivalent to Linux processes or a Node.js runtime          |

The [Container adapter](../src/core/worker/pi/sdk-runtime.ts) uses the existing Linux workspace and its native lease lifecycle.
Its current model provider is the fixed Gateway configuration from [models.ts](../src/core/worker/pi/feature/models.ts).
Keep Gateway credentials at the Durable Object boundary, never in workspace environment variables or prompts.

The [Worker-shell adapter](../src/core/worker/pi/worker-shell-runtime.ts) accepts a pi-ai Models collection and a Pi model through `WorkerShellPiOptions`.
The workspace choice does not select an inference provider.
Its [workspace constructor](../src/core/worker/pi/feature/worker-shell.ts) connects the official shell through `source.type: 'external-runtime'` in the same isolate.
It does not pass a Workspace capability through native Worker RPC or require a Loader binding.
The adapter returns HTTP 404 for the computerd endpoint because this backend has no Container upgrade endpoint.

Use the Container backend for tasks that require an actual Linux checkout, package installation, or Node.js and Vite+ commands.
Use the DO-only backend only for tasks that fit the official shell and Workspace capabilities.
A shell command interface does not establish support for arbitrary operating-system executables.

### Shared Pi operations

Both adapters expose the same [PiSandbox](../src/core/feature/pi/sandbox.ts) contract through [makeHarnessSandbox](../src/core/worker/pi/feature/harness-sandbox.ts):

- `ensureSession(runId)` initializes the backend and obtains the original root session.
- `submitTurn(runId, request)` submits a prompt with its durable command ID.
- `getTurn(runId, commandId)` reads the receipt for that exact operation.
- `complete(runId)` checks for pending work and acknowledges completion without deleting durable storage.

The official root session is `ROOT_SESSION = '1'`, scoped to each run Durable Object.
PiHarness owns conversation and operation persistence.
D1 owns workflow checkpoints and events.
Changing a workspace backend does not move those ownership boundaries.

[PiNodeEffects](../src/core/feature/pi/node.ts) supplies `allocate`, `submit`, `poll`, and `complete` for Machine-owned invokes.
The workflow checkpoints its intent before submission and keeps the allocated execution and command IDs in native state.
`submit` reconciles an existing receipt before submitting an absent command.
`poll` does not resubmit a missing command automatically.
The workflow chooses its waiting, success, and failure transitions.
No generic exactly-once guarantee follows from receipt reconciliation.

## Workers AI text generation

[WorkersAiText](../src/core/feature/llm/workers-ai-text.ts) wraps Alchemy's official AI binding for nonstreaming prompt-to-text inference.
Acquire `WorkersAiTextLive` at the runtime root with Alchemy's `AIBinding` Layer.
`generate(input, model?)` accepts the shared native prompt input and an optional `WorkersAiTextModel`.
The supported model IDs are:

- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, the default exported as `workersAiTextModel`.
- `@cf/meta/llama-3.1-8b-instruct-fp8`.

The `WorkersAiTextModel` Schema also validates a model ID received at an external boundary.
The service always sends `stream: false`.
A Machine invoke can then call the captured service without native Worker runtime requirements:

```ts
import { Effect } from 'effect'

import { WorkersAiText } from '@/core/feature/llm/workers-ai-text'

const generate = Effect.gen(function* () {
  const text = yield* WorkersAiText
  return yield* text.generate(
    { prompt: 'Summarize the committed workflow result.' },
    '@cf/meta/llama-3.1-8b-instruct-fp8',
  )
})
```

Use this Effect as an ordinary invoke effect in the workflow's native Machine definition.
The workflow decides where the generated text is stored and which transition follows it.
The service validates text responses rather than treating asynchronous receipts or tool-only output as completed text.
Inference errors remain typed failures that the workflow can route through its normal failure transition.
Other native Workers AI model families are not admitted by this text-only API.
They need their own typed input and output adapter rather than an arbitrary model string.
A direct text-generation request has no PiHarness operation receipt or durable conversation.
Resuming an interrupted text invoke can issue another inference request.

### Provider configuration

Workers AI text generation and Pi inference are separate capabilities.
The native AI binding does not replace the Pi Gateway provider or put credentials in a Container.
A pi-ai Models collection and Pi model can be supplied independently to the Worker-shell constructor.
A custom-provider option is not required to use the common nodes.
The current code does not expose a universal provider-selection API for every backend, but this does not make other provider adapters impossible.
Add an adapter at the runtime composition boundary when a workflow needs a provider contract that the current constructors do not expose.

## Resource lifetime and serializable state

Construct complete service Layers at the runtime root.
Do not rebuild a Layer or select a backend inside each node operation.
Use [ResourceStore](../src/core/feature/workflow/resource-store.ts) for lazy execution-scoped acquisition and sharing of volatile capabilities.
A failed acquisition closes its attempt Scope, while a successful resource remains attached to the execution Scope.
A resumed execution acquires fresh runtime resources from its new Scope.

The Worker-shell workspace releases its volatile client through `Effect.acquireRelease`.
The Worker-shell Pi adapter registers `harness.dispose()` as a Scope finalizer.
Those finalizers close in-memory resources, not Workspace SQLite or durable Pi conversation state.
Container retention remains a separate lifecycle policy described in [workspace retention](development-workflow-retention.md).
Do not assume that closing an Effect Scope stops a Container or deletes a run.

Persist only serializable values such as operation IDs, execution IDs, prompts, outputs, and native Machine state.
Never serialize a Harness, SDK instance, Workspace stub, AI client, function, or ResourceStore.
Keep SDK callbacks and native Request, Response, and WebSocket conversion inside the owning runtime adapter.

## Verification boundaries

The maintained tests separate local runtime behavior from external inference:

| Test                                                                       | What it exercises                                                                                                                                                         | What it does not establish                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Worker-shell runtime](../src/core/worker/pi/worker-shell-runtime.test.ts) | Actual local workerd Durable Object, official PiHarness initialization, durable file access after Scope closure, and official shell execution without Container or Loader | A real model turn, deployed backend operation, or Linux and Node.js compatibility |
| [Workers AI text](../src/core/feature/llm/workers-ai-text.test.ts)         | Real Alchemy AI binding adapter and native Machine progression with synthetic inference responses                                                                         | Actual Workers AI model availability, credentials, latency, or deployed inference |
| [Shared Pi node effects](../src/core/feature/pi/node.test.ts)              | Workflow-neutral operations and receipt handling with a controlled sandbox service                                                                                        | A real PiHarness model turn or Container execution                                |

The Worker-shell fixture deliberately rejects external network access.
Its unsupported-command case checks that `node --version` fails rather than claiming Node.js support.
Local initialization or a synthetic inference response is not acceptance of a complete Pi workflow.
A prior local application E2E attempt stopped at missing `CLOUDFLARE_ACCOUNT_ID` before browser verification.
That blocked attempt establishes no browser or deployed inference success.
See [Pi development acceptance limits](development-sandbox.md) for the separate Container evidence and remaining limitations.
