import { readD1Migrations } from '@cloudflare/vitest-plugin'
import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { defineQuery } from '@totto2727/reylo'
import { QueryDecodeError, QueryExecutor } from '@totto2727/reylo/effect'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { Array, Effect, Exit, Fiber, Layer } from 'effect'
import { TestCrypto } from 'effect/testing'
import { describe, expect, expectTypeOf, vi } from 'vite-plus/test'

import { makeWorkflows } from '@/bridge/workflow/core/feature/workflow'
import { makeWorkflowRegistry } from '@/bridge/workflow/user-land/feature/registration'
import { makeD1Batch } from '@/core/feature/d1/batch'
import { D1Client } from '@/core/feature/d1/client'
import { D1Binding, NativeD1Client } from '@/core/feature/d1/native'
import { AlchemyQueryExecutorLive } from '@/core/feature/d1/reylo'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { D1StoreLive } from '@/core/feature/workflow/services/d1-store'
import { execute } from '@/core/feature/workflow/services/database'
import { DatabaseQueries, DatabaseQueriesLive } from '@/core/feature/workflow/services/database-queries'
import { EventRange, Store } from '@/core/feature/workflow/services/store'
import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'
import { demoGraph } from '@/user-land/workflow/demo/feature/demo'

import { command, d1Fixture, newRun, unavailableDevelopmentBinding, version1 } from './d1-workflows.fixture.ts'

const isolatedExit = Effect.fn(function* <A, E>(effect: Effect.Effect<A, E>) {
  const fiber = yield* Effect.forkScoped(effect)
  return yield* Fiber.await(fiber)
})

describe('D1 query adapter', () => {
  live('uses the published Reylo decoder and captured Alchemy executor despite a conflicting caller context', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const lookup = defineQuery<{ active: boolean }, { active: boolean; document: { name: string } }, 'one', 'sqlite'>(
        {
          cardinality: 'one',
          columns: [
            ['active', 'bool'],
            ['document', 'json'],
          ],
          dialect: 'sqlite',
          inputs: { active: { nullable: false, type: { kind: 'scalar', name: 'BOOLEAN' } } },
          params: ['active'],
          sql: `SELECT :active AS active, '{"name":"Flowdeck"}' AS document`,
        },
      )
      const queries = yield* fixture.freshQueries()
      const result = queries.run(lookup, { active: true })
      expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<never>()
      const unexpected = vi.fn(() => Effect.die('The caller executor must not be used'))
      const expected = { active: true, document: { name: 'Flowdeck' } }
      const observed = yield* result
      const underConflictingContext = yield* result.pipe(
        Effect.provideService(QueryExecutor, { dialect: 'sqlite', execute: unexpected }),
      )
      expect([observed, underConflictingContext]).toStrictEqual([expected, expected])
      expect(unexpected).not.toHaveBeenCalled()
    }),
  )

  live('maps a published Reylo cardinality failure to a storage failure without losing its original cause', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const query = defineQuery<{}, { value: number }, 'one', 'sqlite'>({
        dialect: 'sqlite',
        sql: 'SELECT 1 AS value UNION ALL SELECT 2 AS value',
        params: [],
        columns: [['value', 'int']],
        cardinality: 'one',
      })
      const queries = yield* fixture.freshQueries()
      const result = queries.run(query)
      const queryError = yield* result.pipe(Effect.flip)
      expect(queryError).toBeInstanceOf(QueryDecodeError)
      const error = yield* execute('read one value', Effect.fail(queryError)).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ExternalError)
      expect(error.cause).toBe(queryError.cause)
      expect(error).toMatchObject({ kind: 'storage', operation: 'read one value' })
      expect(error.cause).toMatchObject({ message: expect.stringContaining('Expected exactly one row, got 2') })
    }),
  )

  live('retains a preparation failure before constructing or executing an atomic write batch', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const query = defineQuery<{ value: number }, never, 'none', 'sqlite'>({
        cardinality: 'none',
        columns: [],
        dialect: 'sqlite',
        inputs: { value: { nullable: false, type: { kind: 'scalar', name: 'INTEGER' } } },
        params: ['value'],
        sql: 'INSERT INTO workflows (workflow_id, name) VALUES (:value, :value)',
      })
      const cause = new Error('Input accessor failed')
      const input = {
        get value(): number {
          throw cause
        },
      }
      const queries = yield* fixture.freshQueries()
      const error = yield* queries.prepare(query, input).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ExternalError)
      expect(error.cause).toBe(cause)
      const runs = yield* fixture.store.listRuns
      expect(runs).toStrictEqual([])
      const count = yield* Effect.promise(async () =>
        fixture.database.prepare('SELECT count(*) AS count FROM workflows').first(),
      )
      expect(count).toStrictEqual({ count: 0 })
    }),
  )

  live('preserves read interruption through the Alchemy executor and published query runner', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const clientLayer = NativeD1Client.pipe(Layer.provide(Layer.succeed(D1Binding, fixture.database)))
      const client = yield* D1Client.pipe(Effect.provide(clientLayer))
      const statement = client.prepare('SELECT 1 AS value')
      const bind = vi.spyOn(statement, 'bind').mockReturnValue(statement)
      const interrupt = vi.spyOn(statement, 'all').mockReturnValue(Effect.interrupt)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          interrupt.mockRestore()
          bind.mockRestore()
        }),
      )
      const query = defineQuery<{}, { value: number }, 'one', 'sqlite'>({
        cardinality: 'one',
        columns: [['value', 'int']],
        dialect: 'sqlite',
        params: [],
        sql: 'SELECT 1 AS value',
      })
      const queryLayer = DatabaseQueriesLive.pipe(
        Layer.provide(AlchemyQueryExecutorLive),
        Layer.provide(Layer.succeed(D1Client, { ...client, prepare: () => statement })),
      )
      const queries = yield* DatabaseQueries.pipe(Effect.provide(queryLayer))
      const read = queries.read('read value', query)
      const fiber = yield* Effect.forkScoped(read)
      const outcome = yield* Fiber.await(fiber)
      expect(Exit.hasInterrupts(outcome)).toBe(true)
    }),
  )

  live('captures an externally composed query service without requiring a database at Store construction', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      expectTypeOf(D1StoreLive).toEqualTypeOf<Layer.Layer<Store, never, DatabaseQueries>>()
      const queries = yield* fixture.freshQueries()
      const layer = D1StoreLive.pipe(Layer.provide(Layer.succeed(DatabaseQueries, queries)))
      const supplied = yield* Store.pipe(Effect.provide(layer))
      const initial = yield* newRun(command().runId)
      const graph = demoGraph(version1)
      yield* supplied.create(initial, graph, demoDefinition.summary.name)
      const detail = yield* supplied.getRun(initial.runId)
      const runs = yield* supplied.listRuns
      const storedGraph = yield* supplied.getGraph(initial.graphId)
      expect({ detail, runs, storedGraph }).toStrictEqual({ detail: initial, runs: [initial], storedGraph: graph })
      const committed = yield* supplied.commit(command())
      const events = yield* supplied.getEvents(initial.runId, EventRange.All())
      expect(committed).toMatchObject({ revision: 1 })
      expect(events).toHaveLength(1)
    }),
  )

  live('captures workflow service dependencies once and runs every operation without a caller context', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const workflows = yield* Workflows.pipe(
        Effect.provide(
          Layer.effect(Workflows, makeWorkflows).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Store, fixture.store),
                Layer.effect(WorkflowRegistry, makeWorkflowRegistry).pipe(
                  Layer.provide(Layer.mergeAll(fixture.testBinding, unavailableDevelopmentBinding)),
                ),
                TestCrypto.layer('captured-workflow-service').pipe(Layer.provide(BrowserCrypto.layer)),
              ),
            ),
          ),
        ),
      )

      // Construction has ended. These calls deliberately supply no Store, registry,
      // Crypto, database, or Workflows context to the returned service operations.
      expect(yield* workflows.listRuns()).toStrictEqual({ runs: [] })
      expect(yield* workflows.listWorkflows()).toMatchObject({
        workflows: expect.arrayContaining([expect.objectContaining({ workflowId: 'demo' })]),
      })
      const created = yield* workflows.createRun({ workflowId: 'demo', version: version1 })
      expect(created.run).toMatchObject({ revision: 2, status: 'waiting' })
      expect(yield* workflows.getRunDetail(created.run.runId)).toStrictEqual(created)
      expect(yield* workflows.listRuns()).toStrictEqual({ runs: [created.run] })
      const resumed = yield* workflows.resumeRun(created.run.runId)
      expect(resumed.run).toMatchObject({ runId: created.run.runId, status: 'completed', revision: 4 })
      expect(yield* workflows.getRunDetail(created.run.runId)).toStrictEqual(resumed)
      expect(yield* workflows.listRuns()).toStrictEqual({ runs: [resumed.run] })
    }),
  )

  live('executes already prepared statements without preparing inside batch', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      expectTypeOf<Parameters<Effect.Success<typeof makeD1Batch>>[0]>().toEqualTypeOf<PreparedStatement[]>()
      const client = yield* D1Client.pipe(
        Effect.provide(NativeD1Client.pipe(Layer.provide(Layer.succeed(D1Binding, fixture.database)))),
      )
      const prepared = client
        .prepare('INSERT INTO workflows (workflow_id, name) VALUES (?, ?)')
        .bind('prepared', 'Prepared')
      const prepare = vi.fn(() => {
        throw new Error('Preparation must happen before batch')
      })
      const batch = yield* makeD1Batch.pipe(Effect.provideService(D1Client, { ...client, prepare }))
      yield* batch([prepared])
      expect(prepare).not.toHaveBeenCalled()
      yield* Effect.promise(async () =>
        expect(
          fixture.database.prepare('SELECT name FROM workflows WHERE workflow_id = ?').bind('prepared').first(),
        ).resolves.toStrictEqual({ name: 'Prepared' }),
      )
    }),
  )

  live('keeps each store bound to its own Layer-provided database', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const otherDatabase = yield* Effect.promise(async () => fixture.miniflare.getD1Database('OTHER'))
      const migrations = yield* Effect.promise(async () => readD1Migrations('migrations'))
      yield* Effect.promise(async () =>
        otherDatabase.batch(
          Array.map(
            Array.flatMap(migrations, (migration) => migration.queries),
            (query) => otherDatabase.prepare(query),
          ),
        ),
      )
      const otherStore = yield* Store.pipe(
        Effect.provide(
          D1StoreLive.pipe(
            Layer.provide(DatabaseQueriesLive),
            Layer.provide(AlchemyQueryExecutorLive),
            Layer.provide(NativeD1Client),
            Layer.provide(Layer.succeed(D1Binding, otherDatabase)),
          ),
        ),
      )
      const otherRunId = 'run_00000000-0000-4000-8000-000000000002'
      yield* otherStore.create(yield* newRun(otherRunId), demoGraph(version1), demoDefinition.summary.name)
      expect(yield* fixture.store.listRuns).toStrictEqual([])
      yield* fixture.seedEffect()
      expect(yield* fixture.store.listRuns).toMatchObject([{ runId: command().runId }])
      expect(yield* otherStore.listRuns).toMatchObject([{ runId: otherRunId }])
    }),
  )

  live('preserves executor interruption without converting it into a storage failure', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const client = yield* D1Client.pipe(
        Effect.provide(NativeD1Client.pipe(Layer.provide(Layer.succeed(D1Binding, fixture.database)))),
      )
      const interrupted = yield* Store.pipe(
        Effect.provide(
          D1StoreLive.pipe(
            Layer.provide(DatabaseQueriesLive),
            Layer.provide(AlchemyQueryExecutorLive),
            Layer.provide(
              Layer.succeed(D1Client, {
                ...client,
                batch: () => Effect.interrupt,
              }),
            ),
          ),
        ),
      )
      const exit = yield* isolatedExit(
        interrupted.create(yield* newRun(command().runId), demoGraph(version1), demoDefinition.summary.name),
      )
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(yield* fixture.store.listRuns).toStrictEqual([])
    }),
  )

  live('uses Alchemy executors without evaluating the raw client binding', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const client = yield* D1Client.pipe(
        Effect.provide(NativeD1Client.pipe(Layer.provide(Layer.succeed(D1Binding, fixture.database)))),
      )
      const raw = vi.fn(() => {
        throw new Error('Raw access is forbidden')
      })
      fixture.store = yield* Store.pipe(
        Effect.provide(
          D1StoreLive.pipe(
            Layer.provide(DatabaseQueriesLive),
            Layer.provide(AlchemyQueryExecutorLive),
            Layer.provide(
              Layer.succeed(D1Client, {
                ...client,
                raw: Effect.sync(raw),
              }),
            ),
          ),
        ),
      )
      yield* fixture.seedEffect()
      expect(yield* fixture.store.listRuns).toHaveLength(1)
      expect(yield* fixture.store.getGraph(demoGraph(version1).graphId)).toStrictEqual(demoGraph(version1))
      expect(yield* fixture.store.commit(command())).toMatchObject({ revision: 1 })
      expect(yield* fixture.store.getRun(command().runId)).toMatchObject({ revision: 1 })
      expect(yield* fixture.store.getEvents(command().runId, EventRange.All())).toHaveLength(1)
      expect(raw).not.toHaveBeenCalled()
    }),
  )
})
