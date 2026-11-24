import type { Models } from '@earendil-works/pi-ai'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { PiHarness } from 'agents/harness/pi'
import type { PiModel } from 'agents/harness/pi'
import { Lifecycle } from 'agents/lifecycle'
import { Effect } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'

import { makeHarnessSandbox } from './feature/harness-sandbox.ts'
import { sdkWebSocketEvents } from './feature/sdk-websocket.ts'
import { makeWorkerShellWorkspace } from './feature/worker-shell.ts'
import { createWorkspaceTools, WORKER_SHELL_BACKEND } from './feature/workspace.ts'

/** Model dependencies are supplied independently from workspace provisioning. */
export type WorkerShellPiOptions = Readonly<{
  model: PiModel
  models: Models
}>

const notFound = 404

// Use the official just-bash Workspace for the Durable Object’s Worker shell.
export const makeWorkerShellPiSdk = Effect.fn('flowdeck.makeWorkerShellPiSdk')(function* (
  options: WorkerShellPiOptions,
) {
  const { host, workspace } = yield* makeWorkerShellWorkspace
  const harness = new PiHarness({
    defaults: { model: options.model },
    harness: async ({ storage, context }) => {
      const registry = createRegistry()
      registry.install({ name: 'workspace', tools: createWorkspaceTools(workspace, WORKER_SHELL_BACKEND) })
      return Harness.open(storage, { models: options.models, registry }, context)
    },
  })
  // Official dispose closes in-memory Harness resources only. Durable Pi and
  // Workspace SQLite survive this activation/execution Scope.
  yield* Effect.addFinalizer(() => Effect.promise(async () => harness.dispose()))
  const lifecycle = new Lifecycle(host).use(harness)
  const sandbox = yield* makeHarnessSandbox({
    harness,
    initialize: () =>
      Effect.tryPromise({
        catch: (cause) =>
          new ExternalError({ cause, kind: 'service', operation: 'initialize Worker shell Pi resource' }),
        try: async () => lifecycle.start(),
      }),
    modelId: options.model.id,
  })
  return {
    // A Worker shell has no computerd upgrade endpoint.
    fetch: (_request: Request) => Effect.succeed(new Response('Not found', { status: notFound })),
    lifecycle,
    sandbox,
    ...sdkWebSocketEvents(lifecycle),
  }
})
