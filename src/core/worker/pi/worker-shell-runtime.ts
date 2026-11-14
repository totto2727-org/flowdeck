import type { WebSocket as WorkerWebSocket } from '@cloudflare/workers-types'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { PiHarness, type PiModel } from 'agents/harness/pi'
import { Lifecycle } from 'agents/lifecycle'
import { Effect } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'

import { makeHarnessSandbox } from './feature/harness-sandbox'
import { makeWorkerShellWorkspace } from './feature/worker-shell'
import { createWorkspaceTools, WORKER_SHELL_BACKEND } from './feature/workspace'

/** Model dependencies are supplied independently from workspace provisioning. */
export interface WorkerShellPiOptions {
  readonly models: Parameters<typeof Harness.open>[1]['models']
  readonly model: PiModel
}

/** DO-owned PiHarness and Workspace with official just-bash, not a Linux runtime. */
export const makeWorkerShellPiSdk = (options: WorkerShellPiOptions) =>
  Effect.gen(function* () {
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
    yield* Effect.addFinalizer(() => Effect.promise(() => harness.dispose()))
    const lifecycle = new Lifecycle(host).use(harness)
    const sandbox = yield* makeHarnessSandbox({
      harness,
      modelId: options.model.id,
      initialize: () =>
        Effect.tryPromise({
          try: () => lifecycle.start(),
          catch: (cause) =>
            new ExternalError({ operation: 'initialize Worker shell Pi resource', kind: 'service', cause }),
        }),
    })
    return {
      sandbox,
      // This backend has no computerd upgrade endpoint. A 404 preserves the
      // adapter shape without inventing a Container or inference protocol.
      fetch: (_request: Request) => Effect.succeed(new Response('Not found', { status: 404 })),
      webSocketMessage: (socket: WorkerWebSocket, message: string | ArrayBuffer) =>
        Effect.promise(() => lifecycle.webSocketMessage(socket as unknown as WebSocket, message)),
      webSocketClose: (socket: WorkerWebSocket, code: number, reason: string, wasClean: boolean) =>
        Effect.promise(() => lifecycle.webSocketClose(socket as unknown as WebSocket, code, reason, wasClean)),
      webSocketError: (socket: WorkerWebSocket, error: unknown) =>
        Effect.promise(() => lifecycle.webSocketError(socket as unknown as WebSocket, error)),
      lifecycle,
    }
  })
