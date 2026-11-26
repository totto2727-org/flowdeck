import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { Array, Effect, Layer, Ref } from 'effect'
import { expect, vi } from 'vite-plus/test'

import type { Run } from '@/core/feature/workflow/domain/model'
import { LifecycleHook } from '@/core/feature/workflow/lifecycle'
import { EventRange, Store } from '@/core/feature/workflow/services/store'
import type { StoreService } from '@/core/feature/workflow/services/store'
import { makeDemoExecutor } from '@/user-land/workflow/demo/feature/demo'

import { command, d1Fixture } from './d1-workflows.fixture.ts'

interface Observation {
  eventIds: Readonly<string[]>
  persisted: Run
  revision: number
  storedEventIds: Readonly<string[]>
}

const hooksFor = (store: StoreService, observed: Ref.Ref<Readonly<Observation[]>>): typeof LifecycleHook.Service => ({
  afterCommit: (events, ack) =>
    Effect.gen(function* () {
      const persisted = yield* store.getRun(ack.runId).pipe(Effect.orDie)
      const range = EventRange.ThroughRevision({ revision: ack.revision })
      const committed = yield* store.getEvents(ack.runId, range).pipe(Effect.orDie)
      const batch = Array.filter(committed, (event) => event.sequence >= ack.firstSequence)
      const observation = {
        eventIds: Array.map(events, (event) => event.eventId),
        persisted,
        revision: ack.revision,
        storedEventIds: Array.map(batch, (event) => event.eventId),
      }
      yield* Ref.update(observed, (prior) => Array.append(prior, observation))
    }),
})

const executorWithHooks = (
  store: StoreService,
  hook: typeof LifecycleHook.Service,
): Effect.Effect<Effect.Success<typeof makeDemoExecutor>> => {
  const services = Layer.mergeAll(Layer.succeed(Store, store), BrowserCrypto.layer, Layer.succeed(LifecycleHook, hook))
  return makeDemoExecutor.pipe(Effect.provide(services))
}

live('observes lifecycle hooks only after the matching snapshot and complete event batch are readable in D1', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const { runId } = command()
    yield* fixture.seedEffect(runId)
    const observed = yield* Ref.make<Readonly<Observation[]>>([])
    const executor = yield* executorWithHooks(fixture.store, hooksFor(fixture.store, observed))
    yield* Effect.andThen(executor.start(runId), () => executor.resume(runId))
    const observations = yield* Ref.get(observed)
    expect(Array.map(observations, (observation) => observation.revision)).toStrictEqual(Array.range(1, 4))
    Array.forEach(observations, (observation) => {
      expect(observation.persisted.revision).toBe(observation.revision)
      expect(observation.storedEventIds).toStrictEqual(observation.eventIds)
    })
    expect(Array.last(observations)).toMatchObject({ value: { persisted: { status: 'completed' } } })
  }),
)

const conflictingRevision = 999
const rejectCheckpoint = (store: StoreService): StoreService => ({
  ...store,
  commit: (input) => store.commit({ ...input, expectedRevision: conflictingRevision }),
})

live('does not dispatch lifecycle hooks when D1 rejects the checkpoint revision', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const { runId } = command()
    yield* fixture.seedEffect(runId)
    const persisted = fixture.store
    const afterCommit = vi.fn<typeof LifecycleHook.Service.afterCommit>(() => Effect.void)
    const executor = yield* executorWithHooks(rejectCheckpoint(persisted), { afterCommit })
    expect(yield* Effect.flip(executor.start(runId))).toBeDefined()
    expect(afterCommit).not.toHaveBeenCalled()
    expect(yield* persisted.getRun(runId)).toMatchObject({ revision: 0, status: 'pending' })
    expect(yield* persisted.getEvents(runId, EventRange.All())).toStrictEqual([])
  }),
)
