import { live } from '@effect/vitest'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { Data, Effect, Exit, Fiber, Layer } from 'effect'
import { expect, expectTypeOf, vi } from 'vite-plus/test'

import { makeD1Batch } from '@/core/feature/d1/batch'
import { D1Client } from '@/core/feature/d1/client'
import { EventRange } from '@/core/feature/workflow/services/store'

import { clientForDatabase, storeWithClient } from './d1-workflow-database.fixture.ts'
import { command, d1Fixture, demoWorkflowName, newRun, primaryGraph } from './d1-workflows.fixture.ts'

class AdapterFixtureError extends Data.TaggedError('AdapterFixtureError')<{ message: string }> {}
const isolatedExit = Effect.fn(function* <A, E>(effect: Effect.Effect<A, E>) {
  const fiber = yield* Effect.forkScoped(effect)
  return yield* Fiber.await(fiber)
})

live('executes already prepared statements without preparing inside batch', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    expectTypeOf<Parameters<Effect.Success<typeof makeD1Batch>>[0]>().toEqualTypeOf<PreparedStatement[]>()
    const client = yield* clientForDatabase(fixture.database)
    const prepared = client
      .prepare('INSERT INTO workflows (workflow_id, name) VALUES (?, ?)')
      .bind('prepared', 'Prepared')
    const prepare = vi.fn<typeof D1Client.Service.prepare>(() => {
      throw new AdapterFixtureError({ message: 'Preparation must happen before batch' })
    })
    const batch = yield* makeD1Batch.pipe(Effect.provideService(D1Client, { ...client, prepare }))
    yield* batch([prepared])
    expect(prepare).not.toHaveBeenCalled()
    const read = fixture.database.prepare('SELECT name FROM workflows WHERE workflow_id = ?').bind('prepared')
    expect(yield* Effect.promise(async () => read.first())).toStrictEqual({ name: 'Prepared' })
  }),
)

live('preserves executor interruption without converting it into a storage failure', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const client = yield* clientForDatabase(fixture.database)
    const layer = Layer.succeed(D1Client, { ...client, batch: () => Effect.interrupt })
    const interrupted = yield* storeWithClient(layer)
    const run = yield* newRun(command().runId)
    const create = interrupted.create(run, primaryGraph, demoWorkflowName)
    const exit = yield* isolatedExit(create)
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(yield* fixture.store.listRuns).toStrictEqual([])
  }),
)

const alchemyWithoutRaw = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  const client = yield* clientForDatabase(fixture.database)
  const raw = vi.fn<() => never>(() => {
    throw new AdapterFixtureError({ message: 'Raw access is forbidden' })
  })
  const layer = Layer.succeed(D1Client, { ...client, raw: Effect.sync(raw) })
  fixture.store = yield* storeWithClient(layer)
  yield* fixture.seedEffect()
  return { fixture, raw }
})

live('reads the Alchemy-backed store without evaluating the raw client binding', () =>
  Effect.gen(function* () {
    const { fixture, raw } = yield* alchemyWithoutRaw
    expect(yield* fixture.store.listRuns).toHaveLength(1)
    expect(yield* fixture.store.getGraph(primaryGraph.graphId)).toStrictEqual(primaryGraph)
    expect(raw).not.toHaveBeenCalled()
  }),
)

live('commits through Alchemy without evaluating the raw client binding', () =>
  Effect.gen(function* () {
    const { fixture, raw } = yield* alchemyWithoutRaw
    expect(yield* fixture.store.commit(command())).toMatchObject({ revision: 1 })
    expect(yield* fixture.store.getRun(command().runId)).toMatchObject({ revision: 1 })
    expect(yield* fixture.store.getEvents(command().runId, EventRange.All())).toHaveLength(1)
    expect(raw).not.toHaveBeenCalled()
  }),
)
