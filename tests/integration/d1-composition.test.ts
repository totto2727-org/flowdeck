import { live } from '@effect/vitest'
import { Array, Effect, Layer } from 'effect'
import { expect, expectTypeOf } from 'vite-plus/test'

import { D1StoreLive } from '@/core/feature/workflow/services/d1-store'
import { DatabaseQueries } from '@/core/feature/workflow/services/database-queries'
import { EventRange, Store } from '@/core/feature/workflow/services/store'
import { Workflows } from '@/core/feature/workflow/services/workflows'

import { workflowsLayer } from './d1-workflow-api.fixture.ts'
import { nativeClientLayer, openFixtureBinding, storeWithClient } from './d1-workflow-database.fixture.ts'
import { command, d1Fixture, demoWorkflowName, newRun, primaryGraph, version1 } from './d1-workflows.fixture.ts'

const composedStore = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  const queries = yield* fixture.freshQueries()
  const layer = D1StoreLive.pipe(Layer.provide(Layer.succeed(DatabaseQueries, queries)))
  const store = yield* Store.pipe(Effect.provide(layer))
  const initial = yield* newRun(command().runId)
  yield* store.create(initial, primaryGraph, demoWorkflowName)
  return { initial, store }
})

live('captures an externally composed query service without requiring a database at Store construction', () =>
  Effect.gen(function* () {
    expectTypeOf(D1StoreLive).toEqualTypeOf<Layer.Layer<Store, never, DatabaseQueries>>()
    const { initial, store } = yield* composedStore
    const result = yield* Effect.all({
      detail: store.getRun(initial.runId),
      runs: store.listRuns,
      storedGraph: store.getGraph(initial.graphId),
    })
    expect(result).toStrictEqual({ detail: initial, runs: [initial], storedGraph: primaryGraph })
    const committed = yield* store.commit(command())
    const events = yield* store.getEvents(initial.runId, EventRange.All())
    expect(committed).toMatchObject({ revision: 1 })
    expect(events).toHaveLength(1)
  }),
)

const capturedWorkflows = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  const layer = workflowsLayer(fixture.store, fixture.freshStore)
  return yield* Workflows.pipe(Effect.provide(layer))
})

live('captures dependencies for listing and creating runs without request services', () =>
  Effect.gen(function* () {
    const workflows = yield* capturedWorkflows
    expect(yield* workflows.listRuns()).toStrictEqual({ runs: [] })
    const catalog = yield* workflows.listWorkflows()
    const workflowIds = Array.map(catalog.workflows, (workflow) => workflow.workflowId)
    expect(workflowIds).toContain('demo')
    const created = yield* workflows.createRun({ version: version1, workflowId: 'demo' })
    expect(created.run).toMatchObject({ revision: 2, status: 'waiting' })
    expect(yield* workflows.getRunDetail(created.run.runId)).toStrictEqual(created)
    expect(yield* workflows.listRuns()).toStrictEqual({ runs: [created.run] })
  }),
)

live('captures dependencies for resuming runs without request services', () =>
  Effect.gen(function* () {
    const workflows = yield* capturedWorkflows
    const { run } = yield* workflows.createRun({ version: version1, workflowId: 'demo' })
    const resumed = yield* workflows.resumeRun(run.runId)
    expect(resumed.run).toMatchObject({ revision: 4, runId: run.runId, status: 'completed' })
    expect(yield* workflows.getRunDetail(run.runId)).toStrictEqual(resumed)
    expect(yield* workflows.listRuns()).toStrictEqual({ runs: [resumed.run] })
  }),
)

live('keeps each store bound to its own Layer-provided database', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const otherDatabase = yield* openFixtureBinding(fixture.miniflare, 'OTHER')
    const otherStore = yield* storeWithClient(nativeClientLayer(otherDatabase))
    const otherRunId = 'run_00000000-0000-4000-8000-000000000002'
    const run = yield* newRun(otherRunId)
    yield* otherStore.create(run, primaryGraph, demoWorkflowName)
    expect(yield* fixture.store.listRuns).toStrictEqual([])
    yield* fixture.seedEffect()
    expect(yield* fixture.store.listRuns).toMatchObject([{ runId: command().runId }])
    expect(yield* otherStore.listRuns).toMatchObject([{ runId: otherRunId }])
  }),
)
