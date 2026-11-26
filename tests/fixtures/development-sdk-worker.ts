import { makeDurableObjectBridge } from 'alchemy/Cloudflare/Bridge'
import { DurableObjectState } from 'alchemy/Cloudflare/Workers/DurableObjectState'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers/WorkerRuntime'
import { makeWorkerRuntimeContext } from 'alchemy/Cloudflare/Workers/WorkerRuntimeContext'
import { DurableObject } from 'cloudflare:workers'
import { Context, Effect, Layer } from 'effect'

import { Store } from '@/core/feature/workflow/services/store'
import { makePiSdk } from '@/core/worker/pi/sdk-runtime'

import { exposeSdkMethods } from './development-sdk-operations.ts'

const unexpected = Effect.die('Unexpected workflow persistence access')
const store = Store.of({
  commit: () => unexpected,
  create: () => unexpected,
  getEvents: () => unexpected,
  getGraph: () => unexpected,
  getRun: () => unexpected,
  listRuns: unexpected,
})
const StoreLive = Layer.succeed(Store, store)
const runtime = makeWorkerRuntimeContext('SdkBoundaryTest')

const constructor = Effect.gen(function* () {
  const environment = yield* WorkerEnvironment
  return Effect.gen(function* () {
    const state = yield* DurableObjectState
    const sdk = yield* makePiSdk.pipe(Effect.provide(StoreLive), Effect.provideService(WorkerEnvironment, environment))
    return yield* exposeSdkMethods(sdk, state.raw)
  })
})

// Use Alchemy's real bridge with the production SDK adapter for this workerd fixture.
export const entrypoint = Effect.gen(function* () {
  yield* runtime.export('SdkBoundary', {
    constructor,
    kind: 'durableObject',
    services: Context.empty(),
  })
  return { RuntimeContext: runtime }
})

const bridge = makeDurableObjectBridge(DurableObject, {
  entrypoint,
  stack: { name: 'sdk-boundary', stage: 'test' },
})

// oxlint-disable-next-line typescript/no-unsafe-assignment -- Alchemy's generated Durable Object constructor is typed as any by its public bridge API.
export const SdkBoundary = bridge('SdkBoundary')

// oxlint-disable-next-line import/no-default-export -- Alchemy's generated Worker entry consumes the Effect as a default export.
export default entrypoint
