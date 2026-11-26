import { BrowserCrypto } from '@effect/platform-browser'
import type { Crypto } from 'effect'
import { Effect } from 'effect'

import type { WorkflowVersion } from '@/core/feature/workflow/domain/model'
import { Store } from '@/core/feature/workflow/services/store'
import type { StoreService } from '@/core/feature/workflow/services/store'
import type { RegisteredWorkflow } from '@/core/feature/workflow/services/workflow-definition'

import { makeApi } from './d1-workflow-api.fixture.ts'
import { testBinding } from './d1-workflow-binding.fixture.ts'
import { defaultRunId, seed, version1 } from './d1-workflow-data.fixture.ts'
import { openD1WorkflowTestDatabase } from './d1-workflow-database.fixture.ts'

export { unavailableDevelopmentBinding } from './d1-workflow-binding.fixture.ts'
export { command, demoWorkflowName, newRun, now, primaryGraph, version1, version2 } from './d1-workflow-data.fixture.ts'

const provideTestServices = <A, E>(
  effect: Effect.Effect<A, E, Store | Crypto.Crypto>,
  store: StoreService,
): Effect.Effect<A, E> => effect.pipe(Effect.provideService(Store, store), Effect.provide(BrowserCrypto.layer))

// Each scenario owns real workerd databases and closes them in its Effect scope.
export const d1Fixture = Effect.gen(function* () {
  const { database, miniflare, services } = yield* openD1WorkflowTestDatabase
  const state = { store: yield* services.freshStore }
  return Object.assign(state, {
    api: (registry?: Readonly<RegisteredWorkflow[]>) => makeApi(state.store, services.freshStore, registry),
    database,
    freshQueries: () => services.freshQueries,
    freshStore: services.freshStore,
    miniflare,
    provideTestServices: <A, E>(effect: Effect.Effect<A, E, Store | Crypto.Crypto>) =>
      provideTestServices(effect, state.store),
    seedEffect: (runId = defaultRunId, version: WorkflowVersion = version1) => seed(state.store, runId, version),
    testBinding: testBinding(services.freshStore),
  })
})
