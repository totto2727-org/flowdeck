import { BrowserCrypto } from '@effect/platform-browser'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer } from 'effect'

import { PiSandbox } from '@/core/feature/pi/sandbox'
import { PiContainer } from '@/core/worker/pi/container'
import { PiSdk } from '@/core/worker/pi/sdk-service'
import { makeWorkflowRunStore } from '@/user-land/workflow/run-store'

import { DevelopmentExecutor, makeDevelopmentExecutor } from './feature/development.ts'

// The native Cloudflare module loads in workerd at activation.
const loadSdk = Effect.promise(async () => import('@/core/worker/pi/sdk-runtime')).pipe(
  Effect.flatMap(({ makePiSdk }) => makePiSdk),
)

export const makeDevelopmentRunRuntime = Effect.gen(function* () {
  // Alchemy discovers the Container binding during resource construction.
  yield* PiContainer
  const store = yield* makeWorkflowRunStore
  const environment = yield* WorkerEnvironment
  const workerEnvironment = Layer.succeed(WorkerEnvironment, environment)
  const dependencies = Layer.mergeAll(store, BrowserCrypto.layer, workerEnvironment)
  const sdk = Layer.effect(PiSdk, loadSdk).pipe(Layer.provideMerge(dependencies))
  const sandbox = Layer.effect(
    PiSandbox,
    Effect.map(PiSdk, (service) => service.sandbox),
  ).pipe(Layer.provideMerge(sdk))
  return Layer.effect(DevelopmentExecutor, makeDevelopmentExecutor).pipe(Layer.provideMerge(sandbox))
})
