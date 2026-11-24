import { readD1Migrations } from '@cloudflare/vitest-plugin'
import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { defineQuery } from '@totto2727/reylo'
import { QueryDecodeError, QueryExecutor } from '@totto2727/reylo/effect'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { Array, Data, DateTime, Effect, Exit, Fiber, Layer, Schema, SemVer } from 'effect'
import { TestCrypto } from 'effect/testing'
import { describe, expect, expectTypeOf, vi } from 'vite-plus/test'

import { createRun, makeWorkflows, resumeRun as resumeWorkflowRun } from '@/bridge/workflow/core/feature/workflow'
import { makeWorkflowRegistry } from '@/bridge/workflow/user-land/feature/registration'
import { WorkflowBinding } from '@/bridge/workflow/user-land/feature/workflow-binding'
import { makeD1Batch } from '@/core/feature/d1/batch'
import { D1Client } from '@/core/feature/d1/client'
import { D1Binding, NativeD1Client } from '@/core/feature/d1/native'
import { AlchemyQueryExecutorLive } from '@/core/feature/d1/reylo'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { CommitId, EventId, ExecutionId, RunId } from '@/core/feature/workflow/domain/identity'
import { RunDetail, RunsResponse } from '@/core/feature/workflow/domain/model'
import type { Run } from '@/core/feature/workflow/domain/model'
import { LifecycleHook } from '@/core/feature/workflow/lifecycle'
import { D1StoreLive } from '@/core/feature/workflow/services/d1-store'
import { execute } from '@/core/feature/workflow/services/database'
import { DatabaseQueries, DatabaseQueriesLive } from '@/core/feature/workflow/services/database-queries'
import { EventRange, Store } from '@/core/feature/workflow/services/store'
import type { CommitCommand, StoreService } from '@/core/feature/workflow/services/store'
import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'
import { demoGraph, makeDemoExecutor, resumeRun, startRun } from '@/user-land/workflow/demo/feature/demo'

import {
  command,
  d1Fixture,
  newRun,
  now,
  unavailableDevelopmentBinding,
  version1,
  version2,
} from './d1-workflows.fixture.ts'

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The native HTTP response body has no trusted shape.
const decodeHttpRunDetail = Schema.decodeUnknownEffect(Schema.toCodecJson(RunDetail))
const isolatedExit = Effect.fn(function* <A, E>(effect: Effect.Effect<A, E>) {
  const fiber = yield* Effect.forkScoped(effect)
  return yield* Fiber.await(fiber)
})
class DisconnectedWorkflow extends Data.TaggedError('DisconnectedWorkflow')<{ message: string }> {}

const disconnectedRegistry = Effect.fn(function* (method: 'start' | 'resume') {
  // The SDK converts the native promise rejection at the individual service-binding boundary.
  const binding = makeRpcStub<WorkflowBinding['Service']>({
    [method]: async () => {
      throw new DisconnectedWorkflow({ message: 'Individual worker disconnected' })
    },
  })
  return yield* makeWorkflowRegistry.pipe(
    Effect.provideService(WorkflowBinding, binding),
    Effect.provide(unavailableDevelopmentBinding),
  )
})

describe('d1 persisted run store', () => {
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

  live('retains the original D1 constraint failure and stack for upstream logging', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.store.commit(command())
      const error = yield* fixture.store.commit(command({ snapshot: { changed: true } })).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: 'StorageConflict', cause: { message: expect.stringContaining('flowdeck_') } })
      expect(error).toHaveProperty('cause', expect.any(Error))
      expect(error).toHaveProperty('cause.stack', expect.any(String))
    }),
  )

  live.each([
    { runId: '00000000-0000-4000-8000-000000000001' },
    { workflowId: '../demo' },
    { graphId: 'demo:1.0.0:graph:1' },
  ])('rejects invalid run identity before writing: %j', (identity) =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      expect(
        yield* Effect.flip(
          fixture.store.create(
            { ...(yield* newRun('run_00000000-0000-4000-8000-000000000001')), ...identity },
            demoGraph(version1),
            demoDefinition.summary.name,
          ),
        ),
      ).toMatchObject({ _tag: 'ExternalError', kind: 'storage' })
      expect(yield* fixture.store.listRuns).toStrictEqual([])
    }),
  )

  live('persists a version string but returns a real SemVer domain value', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const row = yield* Effect.promise(async () =>
        fixture.database
          .prepare('SELECT workflow_version FROM runs WHERE run_id = ?')
          .bind('run_00000000-0000-4000-8000-000000000001')
          .first<{ workflow_version: string }>(),
      )
      expect(row?.workflow_version).toBe('1.0.0')
      const restored = yield* (yield* fixture.freshStore).getRun('run_00000000-0000-4000-8000-000000000001')
      expect(SemVer.isSemVer(restored.workflowVersion)).toBe(true)
      expect(SemVer.equals(restored.workflowVersion, version1)).toBe(true)
    }),
  )

  live('persists timestamp strings and nullable SQL node identity but restores DateTime and event variants', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const eventId = 'event_00000000-0000-4000-8000-000000000002'
      const runEvent = { eventId, type: 'run.started', payload: {}, createdAt: now } as const
      yield* fixture.store.commit(command({ events: [runEvent, ...command().events] }))
      const row = yield* Effect.promise(async () =>
        fixture.database
          .prepare('SELECT created_at, updated_at FROM runs WHERE run_id = ?')
          .bind(command().runId)
          .first(),
      )
      expect(row).toStrictEqual({ created_at: DateTime.formatIso(now), updated_at: DateTime.formatIso(now) })
      const physical = yield* Effect.promise(async () =>
        fixture.database
          .prepare('SELECT node_id, execution_id, attempt, created_at FROM run_events WHERE event_id = ?')
          .bind(eventId)
          .first(),
      )
      expect(physical).toStrictEqual({
        node_id: null,
        execution_id: null,
        attempt: null,
        created_at: DateTime.formatIso(now),
      })
      const restored = yield* fixture.freshStore
      expect(yield* restored.getRun(command().runId)).toMatchObject({
        createdAt: now,
        updatedAt: now,
      })
      expect(yield* restored.getEvents(command().runId, EventRange.All())).toStrictEqual([
        { ...runEvent, runId: command().runId, sequence: 1 },
        { ...Array.getUnsafe(command().events, 0), runId: command().runId, sequence: 2 },
      ])
    }),
  )

  live('rejects an obsolete persisted version instead of normalizing it', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      // Corrupt only this isolated database to exercise the read boundary beyond immutable-write guards.
      yield* Effect.promise(async () => fixture.database.prepare('DROP TRIGGER run_identity_immutable').run())
      yield* Effect.promise(async () =>
        fixture.database
          .prepare('INSERT INTO workflow_versions (workflow_id, version, graph_id) VALUES (?, ?, ?)')
          .bind('demo', 'v1', demoGraph(version1).graphId)
          .run(),
      )
      yield* Effect.promise(async () =>
        fixture.database
          .prepare('UPDATE runs SET workflow_version = ? WHERE run_id = ?')
          .bind('v1', 'run_00000000-0000-4000-8000-000000000001')
          .run(),
      )
      expect(yield* Effect.flip(fixture.store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
        _tag: 'ExternalError',
        kind: 'storage',
      })
    }),
  )

  live.each([
    { commitId: '00000000-0000-4000-8000-000000000001' },
    { runId: '00000000-0000-4000-8000-000000000001' },
    { events: [{ ...Array.getUnsafe(command().events, 0), eventId: 'event-1' }] },
    { events: [{ ...Array.getUnsafe(command().events, 0), nodeId: '../prepare' }] },
    {
      events: [
        { ...Array.getUnsafe(command().events, 0), executionId: 'command_00000000-0000-4000-8000-000000000001' },
      ],
    },
  ])('rejects invalid commit identities atomically: %j', (identity) =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const before = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
      expect(yield* Effect.flip(fixture.store.commit(command(identity)))).toMatchObject({
        _tag: 'ExternalError',
        kind: 'storage',
      })
      expect(yield* fixture.store.getRun(before.runId)).toStrictEqual(before)
      expect(yield* fixture.store.getEvents(before.runId, EventRange.All())).toStrictEqual([])
    }),
  )

  live('orders random run IDs by explicit creation time rather than ID value', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const older = {
        ...(yield* newRun('run_ffffffff-ffff-4fff-8fff-ffffffffffff')),
        createdAt: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
      }
      const newer = {
        ...(yield* newRun('run_00000000-0000-4000-8000-000000000000')),
        createdAt: DateTime.makeUnsafe('2026-01-02T00:00:00.000Z'),
      }
      yield* fixture.store.create(newer, demoGraph(version1), demoDefinition.summary.name)
      yield* fixture.store.create(older, demoGraph(version1), demoDefinition.summary.name)
      expect(Array.map(yield* fixture.store.listRuns, (run) => run.runId)).toStrictEqual([newer.runId, older.runId])
    }),
  )

  live('rejects duplicate event IDs inside a new commit without changing receipts, state or events', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const firstEvent = Array.getUnsafe(command().events, 0)
      expect(
        yield* Effect.flip(
          fixture.store.commit(
            command({
              events: [firstEvent, { ...firstEvent, payload: { changed: true } }],
            }),
          ),
        ),
      ).toMatchObject({ _tag: 'Conflict' })
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(
        yield* newRun('run_00000000-0000-4000-8000-000000000001'),
      )
      expect(
        yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All()),
      ).toStrictEqual([])
      expect(yield* fixture.store.commit(command())).toStrictEqual({
        commitId: 'commit_00000000-0000-4000-8000-000000000001',
        eventCount: 1,
        firstSequence: 1,
        revision: 1,
        runId: 'run_00000000-0000-4000-8000-000000000001',
      })
    }),
  )

  live('persists run identity, graph and initial snapshot across store reconstruction', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const restored = yield* fixture.freshStore
      expect(yield* restored.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(
        yield* newRun('run_00000000-0000-4000-8000-000000000001'),
      )
      expect(yield* restored.getGraph(demoGraph(version1).graphId)).toStrictEqual(demoGraph(version1))
      expect(yield* restored.listRuns).toStrictEqual([yield* newRun('run_00000000-0000-4000-8000-000000000001')])
    }),
  )

  live('atomically commits snapshot revision and sequenced execution events before ACK', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      expect(yield* fixture.store.commit(command())).toStrictEqual({
        commitId: 'commit_00000000-0000-4000-8000-000000000001',
        eventCount: 1,
        firstSequence: 1,
        revision: 1,
        runId: 'run_00000000-0000-4000-8000-000000000001',
      })
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 1,
        snapshot: command().snapshot,
        status: 'running',
      })
      expect(
        yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All()),
      ).toStrictEqual([
        { ...Array.getUnsafe(command().events, 0), runId: 'run_00000000-0000-4000-8000-000000000001', sequence: 1 },
      ])
    }),
  )

  live('returns the original ACK for exact duplicate deliveries without advancing revision', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const first = yield* fixture.store.commit(command())
      expect(yield* fixture.store.commit(command())).toStrictEqual(first)
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 1,
      })
      expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toHaveLength(
        1,
      )
    }),
  )

  live('returns an old duplicate ACK after later commits without replaying its snapshot', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const first = yield* fixture.store.commit(command())
      yield* fixture.store.commit(
        command({
          commitId: 'commit_00000000-0000-4000-8000-000000000002',
          expectedRevision: 1,
          status: 'waiting',
          snapshot: { checkpoint: 'later' },
          events: [],
        }),
      )
      expect(yield* fixture.store.commit(command())).toStrictEqual(first)
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 2,
        snapshot: { checkpoint: 'later' },
      })
    }),
  )

  live('rejects reuse of a commit ID with a different event payload', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.store.commit(command())
      expect(yield* Effect.flip(fixture.store.commit(command({ snapshot: { altered: true } })))).toMatchObject({
        _tag: 'StorageConflict',
      })
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 1,
        snapshot: command().snapshot,
      })
    }),
  )

  live('allows exactly one concurrent compare-and-swap winner', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const results = yield* Effect.all(
        [
          fixture.store.commit(command()).pipe(Effect.exit),
          fixture.store
            .commit(command({ commitId: 'commit_00000000-0000-4000-8000-000000000003', events: [] }))
            .pipe(Effect.exit),
        ],
        { concurrency: 'unbounded' },
      )
      expect(Array.filter(results, Exit.isSuccess)).toHaveLength(1)
      expect(Array.filter(results, Exit.isFailure)).toHaveLength(1)
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 1,
      })
    }),
  )

  live('rolls back receipt, snapshot and all events when a later event violates uniqueness', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.store.commit(command())
      const duplicate = Array.getUnsafe(command().events, 0)
      expect(
        yield* Effect.flip(
          fixture.store.commit(
            command({
              commitId: 'commit_00000000-0000-4000-8000-000000000004',
              expectedRevision: 1,
              snapshot: { wrong: 'must roll back' },
              events: [{ ...duplicate, eventId: 'event_00000000-0000-4000-8000-000000000003' }, duplicate],
            }),
          ),
        ),
      ).toMatchObject({ _tag: 'StorageConflict' })
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 1,
        snapshot: command().snapshot,
      })
      expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toHaveLength(
        1,
      )
      // The rejected receipt must not reserve its ID or revision.
      expect(
        yield* fixture.store.commit(
          command({ commitId: 'commit_00000000-0000-4000-8000-000000000004', expectedRevision: 1, events: [] }),
        ),
      ).toMatchObject({ revision: 2 })
    }),
  )

  live('prevents all fresh commits after a run becomes terminal but still ACKs exact duplicates', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const terminal = command({ status: 'completed', snapshot: { done: true } })
      const ack = yield* fixture.store.commit(terminal)
      expect(
        yield* Effect.flip(
          fixture.store.commit(
            command({ commitId: 'commit_00000000-0000-4000-8000-000000000005', expectedRevision: 1, events: [] }),
          ),
        ),
      ).toMatchObject({ _tag: 'StorageConflict' })
      expect(yield* fixture.store.commit(terminal)).toStrictEqual(ack)
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 1,
        status: 'completed',
      })
    }),
  )

  live('bounds event reads to the revision used for a detail snapshot', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.store.commit(command())
      yield* fixture.store.commit(
        command({
          commitId: 'commit_00000000-0000-4000-8000-000000000002',
          expectedRevision: 1,
          events: Array.map(command().events, (event) => ({
            ...event,
            eventId: 'event_00000000-0000-4000-8000-000000000002',
          })),
        }),
      )
      expect(
        yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', {
          _tag: 'ThroughRevision',
          revision: 0,
        }),
      ).toStrictEqual([])
      expect(
        yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', {
          _tag: 'ThroughRevision',
          revision: 1,
        }),
      ).toHaveLength(1)
      expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toHaveLength(
        2,
      )
    }),
  )

  live('rejects graph ID reuse with different immutable graph content', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      expect(
        yield* Effect.flip(
          fixture.store.create(
            yield* newRun('run_00000000-0000-4000-8000-000000000002'),
            { ...demoGraph(version1), nodes: [] },
            demoDefinition.summary.name,
          ),
        ),
      ).toMatchObject({ _tag: 'StorageConflict' })
      expect(yield* fixture.store.listRuns).toHaveLength(1)
      expect(yield* fixture.store.getGraph(demoGraph(version1).graphId)).toStrictEqual(demoGraph(version1))
    }),
  )
})

describe('demo cold restoration', () => {
  live('observes lifecycle hooks only after the matching snapshot and complete event batch are readable in D1', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const { runId } = command()
      yield* fixture.seedEffect(runId)
      let observations: Readonly<
        {
          revision: number
          persisted: Run
          eventIds: Readonly<string[]>
          storedEventIds: Readonly<string[]>
        }[]
      > = []
      const executor = yield* makeDemoExecutor.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Store, fixture.store),
            BrowserCrypto.layer,
            Layer.succeed(LifecycleHook, {
              afterCommit: (events, ack) =>
                Effect.gen(function* () {
                  const persisted = yield* fixture.store.getRun(ack.runId).pipe(Effect.orDie)
                  const committed = yield* fixture.store
                    .getEvents(ack.runId, EventRange.ThroughRevision({ revision: ack.revision }))
                    .pipe(Effect.orDie)
                  observations = Array.append(observations, {
                    revision: ack.revision,
                    persisted,
                    eventIds: Array.map(events, (event) => event.eventId),
                    storedEventIds: Array.map(
                      Array.filter(committed, (event) => event.sequence >= ack.firstSequence),
                      (event) => event.eventId,
                    ),
                  })
                }),
            }),
          ),
        ),
      )
      yield* executor.start(runId)
      yield* executor.resume(runId)
      expect(Array.map(observations, (observation) => observation.revision)).toStrictEqual(Array.range(1, 4))
      Array.forEach(observations, (observation) => {
        expect(observation.persisted.revision).toBe(observation.revision)
        expect(observation.storedEventIds).toStrictEqual(observation.eventIds)
      })
      expect(Array.last(observations)).toMatchObject({ value: { persisted: { status: 'completed' } } })
    }),
  )

  live('does not dispatch lifecycle hooks when D1 rejects the checkpoint revision', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const { runId } = command()
      yield* fixture.seedEffect(runId)
      const persisted = fixture.store
      const afterCommit = vi.fn(() => Effect.void)
      const executor = yield* makeDemoExecutor.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Store, {
              ...persisted,
              commit: (input) => persisted.commit({ ...input, expectedRevision: 999 }),
            }),
            Layer.succeed(LifecycleHook, { afterCommit }),
            BrowserCrypto.layer,
          ),
        ),
      )
      expect(yield* Effect.flip(executor.start(runId))).toBeDefined()
      expect(afterCommit).not.toHaveBeenCalled()
      expect(yield* persisted.getRun(runId)).toMatchObject({ revision: 0, status: 'pending' })
      expect(yield* persisted.getEvents(runId, EventRange.All())).toStrictEqual([])
    }),
  )

  live.each([version1, version2] as const)(
    'captures demo dependencies once and executes %s without a caller context',
    (version) =>
      Effect.gen(function* () {
        const fixture = yield* d1Fixture
        const { runId } = command()
        yield* fixture.seedEffect(runId, version)
        const executor = yield* makeDemoExecutor.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Store, fixture.store),
              TestCrypto.layer('captured-demo-executor').pipe(Layer.provide(BrowserCrypto.layer)),
            ),
          ),
        )
        yield* executor.start(runId)
        expect(yield* (yield* fixture.freshStore).getRun(runId)).toMatchObject({
          revision: 2,
          status: 'waiting',
        })
        yield* executor.resume(runId)
        expect(yield* (yield* fixture.freshStore).getRun(runId)).toMatchObject({
          revision: 4,
          status: 'completed',
        })
        expect(yield* fixture.store.getEvents(runId, EventRange.All())).toHaveLength(10)
      }),
  )

  live('generates prefixed UUIDv4 execution, event and commit identities and ACKs an exact duplicate commit', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const persisted = fixture.store
      let commits: Readonly<CommitCommand[]> = []
      fixture.store = {
        ...persisted,
        commit: (input) => {
          commits = Array.append(commits, input)
          return persisted.commit(input)
        },
      }
      yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
      yield* fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))
      expect(Array.every(commits, (input) => Schema.is(CommitId)(input.commitId))).toBe(true)
      const events = yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())
      expect(Array.every(events, (event) => Schema.is(EventId)(event.eventId))).toBe(true)
      expect(
        Array.every(events, (event) => !('executionId' in event) || Schema.is(ExecutionId)(event.executionId)),
      ).toBe(true)
      const first = Array.getUnsafe(commits, 0)
      const before = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
      expect(yield* fixture.store.commit(first)).toMatchObject({
        commitId: first.commitId,
        revision: 1,
      })
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(before)
      expect(
        yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All()),
      ).toStrictEqual(events)
    }),
  )

  live.each([version1, version2] as const)(
    'restores the waiting %s version in a new service and completes only after explicit resume',
    (version) =>
      Effect.gen(function* () {
        const fixture = yield* d1Fixture
        yield* fixture.seedEffect('run_00000000-0000-4000-8000-000000000001', version)
        yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
        const waiting = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
        expect(waiting).toMatchObject({
          status: 'waiting',
          revision: 2,
          workflowVersion: version,
          snapshot: { version: SemVer.format(version), machine: { active: [{ path: '' }, { path: 'approval' }] } },
        })
        fixture.store = yield* fixture.freshStore
        yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
        expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(waiting)
        yield* fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))
        const completed = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
        expect(completed).toMatchObject({
          status: 'completed',
          revision: 4,
          snapshot: {
            version: SemVer.format(version),
            machine: {
              active: [
                { path: '' },
                {
                  path: 'completed',
                  value: {
                    result: SemVer.equals(version, version1) ? 'published:draft:v1' : 'published:draft:v2:reviewed',
                  },
                },
              ],
            },
          },
        })
        const events = yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())
        expect(Array.map(events, (event) => event.sequence)).toStrictEqual(Array.range(1, 10))
        expect(
          Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'prepare'),
        ).toHaveLength(1)
        expect(
          yield* Effect.flip(fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))),
        ).toMatchObject({
          _tag: 'InvalidOperation',
        })
        expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(completed)
      }),
  )

  live('recovers a committed running prepare checkpoint without duplicating its start event', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const persisted = fixture.store
      fixture.store = {
        ...persisted,
        commit: (input) =>
          persisted.commit(input).pipe(
            Effect.andThen(
              Effect.fail(
                new ExternalError({
                  kind: 'storage',
                  operation: 'lost prepare checkpoint ACK',
                  cause: 'test transport loss',
                }),
              ),
            ),
          ),
      }
      expect(yield* Effect.flip(fixture.provideTestServices(startRun(command().runId)))).toMatchObject({
        _tag: 'ExternalError',
      })
      const checkpoint = yield* persisted.getRun(command().runId)
      expect(checkpoint).toMatchObject({ revision: 1, status: 'running' })
      expect(yield* persisted.getEvents(command().runId, EventRange.All())).toHaveLength(2)
      fixture.store = yield* fixture.freshStore
      yield* fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 2,
        status: 'waiting',
      })
      expect(
        Array.filter(
          yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All()),
          (event) => event.type === 'node.started' && event.nodeId === 'prepare',
        ),
      ).toHaveLength(1)
    }),
  )

  live('rejects malformed or version-mismatched restored state before executing a node', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.store.commit(command({ snapshot: { _tag: 'Preparing', version: 'v9' } }))
      expect(
        yield* Effect.flip(fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))),
      ).toMatchObject({
        _tag: 'InvalidSnapshot',
      })
      expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toHaveLength(
        1,
      )
    }),
  )
})

describe('interrupted workflow recovery', () => {
  live('rejects an unregistered persisted workflow before dispatch without changing its checkpoint', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const unsupported = {
        ...(yield* newRun('run_00000000-0000-4000-8000-000000000004')),
        workflowId: 'unregistered-workflow',
      }
      yield* fixture.store.create(unsupported, demoGraph(version1), 'Unregistered workflow')
      const resume = vi.fn(() => Effect.die('Unregistered workflows must not dispatch'))
      const binding = { start: resume, resume }
      const registry = [{ ...demoDefinition, binding }]
      expect(
        yield* Effect.flip(
          resumeWorkflowRun(unsupported.runId).pipe(
            Effect.provideService(Store, fixture.store),
            Effect.provideService(WorkflowRegistry, registry),
          ),
        ),
      ).toMatchObject({ _tag: 'InvalidOperation', message: 'The workflow is not registered' })
      expect(resume).not.toHaveBeenCalled()
      expect(yield* fixture.store.getRun(unsupported.runId)).toStrictEqual(unsupported)
      expect(yield* fixture.store.getEvents(unsupported.runId, EventRange.All())).toStrictEqual([])
    }),
  )

  live('restores a running publish checkpoint without replaying manual approval or node start', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
      const persisted = fixture.store
      const interrupted: StoreService = {
        ...persisted,
        commit: (input) =>
          input.status === 'completed'
            ? Effect.fail(
                new ExternalError({
                  kind: 'storage',
                  operation: 'injected checkpoint failure',
                  cause: 'test interruption',
                }),
              )
            : persisted.commit(input),
      }
      expect(
        yield* Effect.flip(
          resumeRun('run_00000000-0000-4000-8000-000000000001').pipe(
            Effect.provideService(Store, interrupted),
            Effect.provide(BrowserCrypto.layer),
          ),
        ),
      ).toMatchObject({ _tag: 'ExternalError', kind: 'storage' })
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 3,
        snapshot: { machine: { active: [{ path: '' }, { path: 'publish', value: { prepared: 'draft:v1' } }] } },
        status: 'running',
      })
      fixture.store = yield* fixture.freshStore
      yield* fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))
      const events = yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())
      expect(Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'publish')).toHaveLength(
        1,
      )
      expect(
        Array.filter(events, (event) => event.type === 'node.succeeded' && event.nodeId === 'approval'),
      ).toHaveLength(1)
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 4,
        status: 'completed',
      })
      expect(
        yield* Effect.flip(fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))),
      ).toMatchObject({
        _tag: 'InvalidOperation',
      })
    }),
  )

  live('leaves a recoverable pending run if its native static workflow RPC rejects', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const registry = yield* disconnectedRegistry('start')
      const create = createRun({ version: version1, workflowId: 'demo' }).pipe(
        Effect.provideService(Store, fixture.store),
        Effect.provideService(WorkflowRegistry, registry),
        Effect.provide(BrowserCrypto.layer),
      )
      const error = yield* Effect.flip(create)
      expect(error).toBeInstanceOf(ExternalError)
      expect(error).toHaveProperty('kind', 'service')
      const runs = yield* fixture.store.listRuns
      expect(runs).toMatchObject([{ revision: 0, status: 'pending' }])
      const pending = Array.getUnsafe(runs, 0)
      yield* fixture.provideTestServices(resumeRun(pending.runId))
      expect(yield* fixture.store.getRun(pending.runId)).toMatchObject({ revision: 2, status: 'waiting' })
    }),
  )

  live('keeps the persisted checkpoint unchanged when an individual resume RPC rejects', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const { runId } = command()
      yield* fixture.seedEffect(runId)
      yield* fixture.provideTestServices(startRun(runId))
      const waiting = yield* fixture.store.getRun(runId)
      const events = yield* fixture.store.getEvents(runId, EventRange.All())
      const registry = yield* disconnectedRegistry('resume')
      const resume = resumeWorkflowRun(runId).pipe(
        Effect.provideService(Store, fixture.store),
        Effect.provideService(WorkflowRegistry, registry),
      )
      const error = yield* Effect.flip(resume)
      expect(error).toBeInstanceOf(ExternalError)
      expect(error).toHaveProperty('kind', 'service')
      expect(yield* fixture.store.getRun(runId)).toStrictEqual(waiting)
      expect(yield* fixture.store.getEvents(runId, EventRange.All())).toStrictEqual(events)
    }),
  )
})

describe('effect HTTP API', () => {
  live('rejects bare UUIDv4 run IDs at persistence and HTTP boundaries', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const id = '00000000-0000-4000-8000-000000000003'
      expect(yield* Effect.flip(fixture.seedEffect(id))).toMatchObject({ _tag: 'ExternalError' })
      expect(yield* fixture.store.listRuns).toStrictEqual([])
      const handler = fixture.api()
      try {
        const read = yield* Effect.promise(async () => handler.handler(new Request(`http://localhost/api/runs/${id}`)))
        expect(read.status).toBe(400)
        const resumed = yield* Effect.promise(async () =>
          handler.handler(new Request(`http://localhost/api/runs/${id}/resume`, { method: 'POST' })),
        )
        expect(resumed.status).toBe(400)
        expect(yield* fixture.store.listRuns).toStrictEqual([])
      } finally {
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )

  live('supports an arbitrary workflow through registry-only catalog, creation, detail and resume', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* Effect.tryPromise(async () => {
        const version = SemVer.parseUnsafe('3.4.5-beta.1+build.7')
        const summary = { workflowId: 'review-workflow', name: 'Review changes', versions: [version], inputs: [] }
        const graph = {
          graphId: 'review-workflow-3_4_5-beta_1-build_7-graph-1',
          schemaVersion: 1,
          nodes: [],
          edges: [],
        } as const
        const input = Schema.Struct({
          workflowId: Schema.Literal('review-workflow'),
          version: Schema.SemVer.check(Schema.makeFilter((value) => SemVer.equals(value, version))),
          topic: Schema.String,
        })
        const start = vi.fn((_runId: string) => Effect.void)
        const resume = vi.fn((_runId: string) => Effect.void)
        const persist = vi.spyOn(fixture.store, 'create')
        const handler = fixture.api([
          {
            summary,
            prepare: (value) =>
              Schema.decodeUnknownEffect(input)(value, { onExcessProperty: 'error' }).pipe(
                Effect.map((decoded) => ({ graph, snapshot: { topic: decoded.topic } })),
              ),
            binding: { start, resume },
          },
        ])
        try {
          const catalog = await handler.handler(new Request('http://localhost/api/workflows'))
          expect(catalog.status).toBe(200)
          await expect(catalog.json()).resolves.toStrictEqual({
            workflows: [{ ...summary, versions: [SemVer.format(version)] }],
          })
          const invalid = await handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ workflowId: summary.workflowId, version: '3.4.6', topic: 'Correctness' }),
            }),
          )
          expect(invalid.status).toBe(400)
          expect(persist).not.toHaveBeenCalled()
          expect(start).not.toHaveBeenCalled()
          const created = await handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workflowId: summary.workflowId,
                version: SemVer.format(version),
                topic: 'Correctness',
              }),
            }),
          )
          expect(created.status).toBe(201)
          const detail = Schema.decodeUnknownSync(Schema.toCodecJson(RunDetail))(await created.json())
          // Read the real D1 row at the adapter boundary, not the catalog or a mocked Store call.
          const workflowRow = await fixture.database
            .prepare('SELECT name FROM workflows WHERE workflow_id = ?')
            .bind(summary.workflowId)
            .first<{ name: string }>()
          expect(workflowRow).toStrictEqual({ name: summary.name })
          expect(detail.run).toMatchObject({
            workflowId: summary.workflowId,
            workflowVersion: version,
            graphId: graph.graphId,
            snapshot: { topic: 'Correctness' },
            revision: 0,
          })
          expect(start).toHaveBeenCalledExactlyOnceWith(detail.run.runId)
          const read = await handler.handler(new Request(`http://localhost/api/runs/${detail.run.runId}`))
          expect(read.status).toBe(200)
          await expect(read.json()).resolves.toStrictEqual(Schema.encodeSync(Schema.toCodecJson(RunDetail))(detail))
          const resumed = await handler.handler(
            new Request(`http://localhost/api/runs/${detail.run.runId}/resume`, { method: 'POST' }),
          )
          expect(resumed.status).toBe(200)
          await expect(resumed.json()).resolves.toStrictEqual(Schema.encodeSync(Schema.toCodecJson(RunDetail))(detail))
          expect(resume).toHaveBeenCalledExactlyOnceWith(detail.run.runId)
        } finally {
          persist.mockRestore()
          await handler.dispose()
        }
      })
    }),
  )

  live.each([
    { workflowId: 'demo', version: 'v1' },
    { workflowId: 'demo', version: '1.0.0', unexpected: true },
    {
      workflowId: 'jcode-development',
      version: '1.0.0',
      repository: 'https://github.com/example/project',
      task: 'Valid',
      unexpected: true,
    },
    { workflowId: 'jcode-development', version: '1.0.0', repository: 'https://evil.example/project', task: 'Valid' },
  ])('rejects invalid workflow-owned input before persistence: %j', (input) =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const create = vi.spyOn(fixture.store, 'create')
      const handler = fixture.api()
      try {
        const response = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
            }),
          ),
        )
        expect(response.status).toBe(400)
        expect(create).not.toHaveBeenCalled()
        expect(yield* fixture.store.listRuns).toStrictEqual([])
      } finally {
        create.mockRestore()
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )
  live('rejects browser-originated text/plain create requests without writing a run', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const handler = fixture.api()
      try {
        const response = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
              body: '{"workflowId":"demo","version":"v1"}',
            }),
          ),
        )
        expect(response.status).toBe(403)
        expect(yield* fixture.store.listRuns).toStrictEqual([])
      } finally {
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )

  live('rejects browser-originated resume requests without advancing the persisted checkpoint', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
      const waiting = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
      const events = yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())
      const handler = fixture.api()
      try {
        const response = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs/run_00000000-0000-4000-8000-000000000001/resume', {
              method: 'POST',
              headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
            }),
          ),
        )
        expect(response.status).toBe(403)
        expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(waiting)
        expect(
          yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All()),
        ).toStrictEqual(events)
      } finally {
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )

  live('lists bundled workflows and validates the create boundary', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const handler = fixture.api()
      try {
        const workflows = yield* Effect.promise(async () =>
          handler.handler(new Request('http://localhost/api/workflows')),
        )
        expect(workflows.status).toBe(200)
        yield* Effect.promise(async () =>
          expect(workflows.json()).resolves.toStrictEqual({
            workflows: [
              { inputs: [], name: 'Release checkpoint', versions: ['1.0.0', '2.0.0'], workflowId: 'demo' },
              expect.objectContaining({
                workflowId: 'jcode-development',
                name: 'Pi development',
                versions: ['1.0.0'],
                inputs: [
                  expect.objectContaining({
                    name: 'repository',
                    label: 'Public GitHub repository',
                    kind: 'text',
                    required: true,
                  }),
                  expect.objectContaining({
                    name: 'task',
                    label: 'Development task',
                    kind: 'textarea',
                    required: true,
                    maxLength: 16_000,
                  }),
                ],
              }),
            ],
          }),
        )
        const invalid = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{"workflowId":"demo","version":"v9"}',
            }),
          ),
        )
        expect(invalid.status).toBe(400)
        const unsafeId = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ workflowId: '../demo', version: '1.0.0' }),
            }),
          ),
        )
        expect(unsafeId.status).toBe(400)
        expect(yield* fixture.store.listRuns).toStrictEqual([])
      } finally {
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )

  live.each(['1.0.0', '2.0.0'])(
    'creates, reads and resumes a persisted %s run, then protects the completed run',
    (version) =>
      Effect.gen(function* () {
        const fixture = yield* d1Fixture
        const handler = fixture.api()
        try {
          const created = yield* Effect.promise(async () =>
            handler.handler(
              new Request('http://localhost/api/runs', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workflowId: 'demo', version }),
              }),
            ),
          )
          expect(created.status).toBe(201)
          const json: unknown = yield* Effect.promise(async () => created.json())
          const body = yield* decodeHttpRunDetail(json)
          expect(Schema.is(RunId)(body.run.runId)).toBe(true)
          expect(body.run.status).toBe('waiting')
          const detail = yield* Effect.promise(async () =>
            handler.handler(new Request(`http://localhost/api/runs/${body.run.runId}`)),
          )
          expect(detail.status).toBe(200)
          yield* Effect.promise(async () =>
            expect(detail.json()).resolves.toMatchObject({
              run: { status: 'waiting' },
              shapes: { nodes: [{ state: 'succeeded' }, { state: 'waiting' }, { state: 'idle' }] },
              state: { revision: 2 },
            }),
          )
          const listed = yield* Effect.promise(async () => handler.handler(new Request('http://localhost/api/runs')))
          expect(listed.status).toBe(200)
          yield* Effect.promise(async () =>
            expect(listed.json()).resolves.toStrictEqual(
              Schema.encodeSync(Schema.toCodecJson(RunsResponse))({ runs: [body.run] }),
            ),
          )
          const resumed = yield* Effect.promise(async () =>
            handler.handler(new Request(`http://localhost/api/runs/${body.run.runId}/resume`, { method: 'POST' })),
          )
          expect(resumed.status).toBe(200)
          yield* Effect.promise(async () =>
            expect(resumed.json()).resolves.toMatchObject({
              run: { status: 'completed', workflowVersion: version },
              state: { revision: 4 },
            }),
          )
          const again = yield* Effect.promise(async () =>
            handler.handler(new Request(`http://localhost/api/runs/${body.run.runId}/resume`, { method: 'POST' })),
          )
          expect(again.status).toBe(409)
        } finally {
          yield* Effect.promise(async () => handler.dispose())
        }
      }),
  )

  live('returns 404 for a missing persisted run', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* Effect.tryPromise(async () => {
        const handler = fixture.api()
        try {
          const response = await handler.handler(
            new Request('http://localhost/api/runs/run_00000000-0000-4000-8000-000000000005'),
          )
          expect(response.status).toBe(404)
        } finally {
          await handler.dispose()
        }
      })
    }),
  )
})
