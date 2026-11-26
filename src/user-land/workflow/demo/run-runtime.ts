import { BrowserCrypto } from '@effect/platform-browser'
import { Effect, Layer } from 'effect'

import { makeWorkflowRunStore } from '@/user-land/workflow/run-store'

import { DemoExecutor, makeDemoExecutor } from './feature/demo.ts'

export const makeDemoRunRuntime = Effect.gen(function* () {
  const store = yield* makeWorkflowRunStore
  const dependencies = Layer.mergeAll(store, BrowserCrypto.layer)
  const executor = Layer.effect(DemoExecutor, makeDemoExecutor).pipe(Layer.provide(dependencies))
  return Layer.mergeAll(executor, BrowserCrypto.layer)
})
