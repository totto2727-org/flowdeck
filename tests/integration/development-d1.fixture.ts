import { BrowserCrypto } from '@effect/platform-browser'
import { Effect, Layer } from 'effect'
import type { Crypto } from 'effect'
import { TestCrypto } from 'effect/testing'

import { PiSandbox } from '@/core/feature/pi/sandbox'
import { Store, EventRange } from '@/core/feature/workflow/services/store'
import type { StoreService } from '@/core/feature/workflow/services/store'
import {
  developmentGraph,
  resumeDevelopmentRun,
  startDevelopmentRun,
} from '@/user-land/workflow/development/feature/development'

import { openD1WorkflowTestDatabase } from './d1-workflow-database.fixture.ts'
import { makePiHarness } from './development-pi.fixture.ts'
import { makeInitialRun } from './development-snapshot.fixture.ts'

type DevelopmentContext = Store | PiSandbox | Crypto.Crypto
type Execute = <A, E>(
  operation: Effect.Effect<A, E, DevelopmentContext>,
  provided?: StoreService,
) => Effect.Effect<A, E>

const makeExecute =
  (freshStore: Effect.Effect<StoreService>, getSandbox: () => typeof PiSandbox.Service): Execute =>
  (operation, provided) =>
    Effect.gen(function* () {
      const store = provided ?? (yield* freshStore)
      return yield* operation.pipe(
        Effect.provideService(Store, store),
        Effect.provideService(PiSandbox, getSandbox()),
        Effect.provide(BrowserCrypto.layer),
      )
    })

export const openDevelopmentFixture = Effect.gen(function* () {
  const {
    services: { freshStore },
  } = yield* openD1WorkflowTestDatabase
  const store = yield* freshStore
  const initial = yield* makeInitialRun
  yield* store.create(initial, developmentGraph, 'Pi development')
  const pi = makePiHarness(store)
  const execute = makeExecute(freshStore, pi.sandbox)
  const { runId } = initial
  return {
    current: Effect.flatMap(freshStore, (fresh) => fresh.getRun(runId)),
    events: store.getEvents(runId, EventRange.All()),
    execute,
    freshStore,
    initial,
    pi,
    resume: execute(resumeDevelopmentRun(runId)),
    start: execute(startDevelopmentRun(runId)),
    store,
  }
})

export const developmentApiCrypto = TestCrypto.layer('development-api').pipe(Layer.provide(BrowserCrypto.layer))
