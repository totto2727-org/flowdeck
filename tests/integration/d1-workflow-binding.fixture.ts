import { BrowserCrypto } from '@effect/platform-browser'
import { Effect, Layer } from 'effect'
import { TestCrypto } from 'effect/testing'

import { DevelopmentWorkflowBinding, WorkflowBinding } from '@/bridge/workflow/user-land/feature/workflow-binding'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { Store } from '@/core/feature/workflow/services/store'
import type { StoreService } from '@/core/feature/workflow/services/store'
import { resumeRun, startRun } from '@/user-land/workflow/demo/feature/demo'

const unavailable = (): Effect.Effect<never, ExternalError> =>
  Effect.fail(
    new ExternalError({
      cause: 'Development workflow not selected by this fixture',
      kind: 'service',
      operation: 'test binding',
    }),
  )

export const unavailableDevelopmentBinding = Layer.succeed(DevelopmentWorkflowBinding, {
  resume: unavailable,
  start: unavailable,
})

export const testBinding = (freshStore: Effect.Effect<StoreService>): Layer.Layer<WorkflowBinding> =>
  Layer.succeed(WorkflowBinding, {
    resume: (runId) =>
      Effect.flatMap(freshStore, (persisted) =>
        resumeRun(runId).pipe(Effect.provideService(Store, persisted), Effect.provide(BrowserCrypto.layer)),
      ),
    start: (runId) =>
      Effect.flatMap(freshStore, (persisted) =>
        startRun(runId).pipe(Effect.provideService(Store, persisted), Effect.provide(BrowserCrypto.layer)),
      ),
  })

export const testCrypto = TestCrypto.layer('flowdeck-api').pipe(Layer.provide(BrowserCrypto.layer))
