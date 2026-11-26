import { BrowserCrypto } from '@effect/platform-browser'
import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import type { Crypto } from 'effect'
import { Data, Effect, Layer } from 'effect'
import { vi } from 'vite-plus/test'

import { makeWorkflowRegistry } from '@/bridge/workflow/user-land/feature/registration'
import { WorkflowBinding } from '@/bridge/workflow/user-land/feature/workflow-binding'
import { Store } from '@/core/feature/workflow/services/store'
import type { StoreService } from '@/core/feature/workflow/services/store'
import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import type { WorkflowExecutor } from '@/core/feature/workflow/services/workflow-definition'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'

import { unavailableDevelopmentBinding } from './d1-workflows.fixture.ts'

class DisconnectedWorkflow extends Data.TaggedError('DisconnectedWorkflow')<{ message: string }> {}

export const disconnectedRegistry = Effect.fn('flowdeck.test.disconnectWorkflow')(function* (
  method: 'start' | 'resume',
) {
  const binding = makeRpcStub<WorkflowBinding['Service']>({
    // oxlint-disable-next-line typescript/require-await -- The SDK needs a native Promise rejection to exercise its RPC error mapping.
    [method]: async () => {
      throw new DisconnectedWorkflow({ message: 'Individual worker disconnected' })
    },
  })
  return yield* makeWorkflowRegistry.pipe(
    Effect.provideService(WorkflowBinding, binding),
    Effect.provide(unavailableDevelopmentBinding),
  )
})

export const withRegistry = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  store: StoreService,
  registry: typeof WorkflowRegistry.Service,
): Effect.Effect<A, E, Exclude<R, Store | WorkflowRegistry | Crypto.Crypto>> => {
  const services = Layer.mergeAll(
    Layer.succeed(Store, store),
    Layer.succeed(WorkflowRegistry, registry),
    BrowserCrypto.layer,
  )
  return operation.pipe(Effect.provide(services))
}

export const registryWithoutStoredWorkflow = Effect.sync(() => {
  const resume = vi.fn<WorkflowExecutor['resume']>(() => Effect.die('Unregistered workflows must not dispatch'))
  const binding = { resume, start: resume }
  return { registry: [{ ...demoDefinition, binding }], resume }
})
