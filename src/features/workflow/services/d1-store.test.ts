import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { BrowserCrypto } from '@effect/platform-browser'
import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { Array, Crypto, DateTime, Effect, Exit, Layer, Schema, SemVer } from 'effect'
import { HttpRouter } from 'effect/http'
import { TestCrypto } from 'effect/testing'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ApiRoutes } from '../../../workers/control/features/router'
import { demoDefinition } from '../../../workers/demo-workflow/features/definition'
import {
  DemoSnapshot,
  demoGraph,
  initialSnapshot,
  resumeRun,
  startRun,
} from '../../../workers/demo-workflow/features/demo'
import { makeWorkflowRegistry } from '../../../workers/workflow/features/registration'
import { createRun, makeWorkflows, resumeRun as resumeWorkflowRun } from '../../../workers/workflow/features/workflow'
import { DevelopmentWorkflowBinding, WorkflowBinding } from '../../../workers/workflow/features/workflow-binding'
import { ExternalError } from '../domain/errors'
import { CommitId, EventId, ExecutionId, RunId } from '../domain/identity'
import { RunDetail, RunsResponse, type Run, type WorkflowVersion } from '../domain/model'
import { makeD1Store } from './d1-store'
import { type CommitCommand, Store, type StoreService } from './store'
import { WorkflowRegistry, type RegisteredWorkflow } from './workflow-definition'
import { Workflows } from './workflows'

const version1 = SemVer.parseUnsafe('1.0.0')
const version2 = SemVer.parseUnsafe('2.0.0')
const now = DateTime.makeUnsafe('2026-10-17T12:00:00.000Z')
const newRun = (runId: string, version: WorkflowVersion = version1): Run => ({
  runId,
  workflowId: 'demo',
  workflowVersion: version,
  graphId: demoGraph(version).graphId,
  status: 'pending',
  revision: 0,
  snapshot: Schema.decodeUnknownSync(Schema.JsonObject)(
    Schema.encodeSync(Schema.toCodecJson(DemoSnapshot))(initialSnapshot(version)),
  ),
  createdAt: now,
  updatedAt: now,
})
const command = (overrides: Partial<CommitCommand> = {}): CommitCommand => ({
  commitId: 'commit_00000000-0000-4000-8000-000000000001',
  runId: 'run_00000000-0000-4000-8000-000000000001',
  expectedRevision: 0,
  status: 'running',
  snapshot: {
    _tag: 'Preparing',
    schemaVersion: 1,
    version: '1.0.0',
    executionId: 'execution_00000000-0000-4000-8000-000000000001',
    attempt: 1,
  },
  events: [
    {
      eventId: 'event_00000000-0000-4000-8000-000000000001',
      type: 'node.started',
      nodeId: 'prepare',
      executionId: 'execution_00000000-0000-4000-8000-000000000001',
      attempt: 1,
      payload: {},
      createdAt: now,
    },
  ],
  updatedAt: now,
  ...overrides,
})

// Real local workerd D1, not a memory store or an imitation of SQL transactions.
let miniflare: Miniflare
let database: D1Database
let store: StoreService
beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default {}',
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'flowdeck-test' },
  })
  database = await miniflare.getD1Database('DB')
  const migrations = await readD1Migrations('migrations')
  await database.batch(
    Array.map(
      Array.flatMap(migrations, (migration) => migration.queries),
      (query) => database.prepare(query),
    ),
  )
  store = makeD1Store(database)
})
afterEach(async () => {
  await miniflare.dispose()
})
const run = <A, E>(effect: Effect.Effect<A, E, Store | Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(Store, store), Effect.provide(BrowserCrypto.layer)))
const seed = (runId = 'run_00000000-0000-4000-8000-000000000001', version: WorkflowVersion = version1) =>
  Effect.runPromise(store.create(newRun(runId, version), demoGraph(version), demoDefinition.summary.name))

// A Layer substitutes only the static binding boundary. Its worker implementation
// is the same exported workflow used by the actual Durable Object adapter.
const testBinding = () =>
  Layer.succeed(WorkflowBinding, {
    start: (runId) =>
      startRun(runId).pipe(Effect.provideService(Store, makeD1Store(database)), Effect.provide(BrowserCrypto.layer)),
    resume: (runId) =>
      resumeRun(runId).pipe(Effect.provideService(Store, makeD1Store(database)), Effect.provide(BrowserCrypto.layer)),
  })
const unavailableDevelopmentBinding = Layer.succeed(DevelopmentWorkflowBinding, {
  start: () =>
    Effect.fail(
      new ExternalError({
        kind: 'service',
        operation: 'test binding',
        cause: 'Development workflow not selected by this fixture',
      }),
    ),
  resume: () =>
    Effect.fail(
      new ExternalError({
        kind: 'service',
        operation: 'test binding',
        cause: 'Development workflow not selected by this fixture',
      }),
    ),
})
const api = (registry?: ReadonlyArray<RegisteredWorkflow>) =>
  HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      HttpRouter.provideRequest(
        Layer.effect(Workflows, makeWorkflows).pipe(
          Layer.provide(
            Layer.mergeAll(
              registry === undefined
                ? Layer.effect(WorkflowRegistry, makeWorkflowRegistry).pipe(
                    Layer.provide(Layer.mergeAll(testBinding(), unavailableDevelopmentBinding)),
                  )
                : Layer.succeed(WorkflowRegistry, registry),
              Layer.succeed(Store, store),
              TestCrypto.layer('flowdeck-api').pipe(Layer.provide(BrowserCrypto.layer)),
            ),
          ),
        ),
      ),
    ),
  )

describe('D1 persisted run store', () => {
  it.each([
    { runId: '00000000-0000-4000-8000-000000000001' },
    { workflowId: '../demo' },
    { graphId: 'demo:1.0.0:graph:1' },
  ])('rejects invalid run identity before writing: %j', async (identity) => {
    await expect(
      Effect.runPromise(
        store.create(
          { ...newRun('run_00000000-0000-4000-8000-000000000001'), ...identity },
          demoGraph(version1),
          demoDefinition.summary.name,
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'storage' })
    expect(await Effect.runPromise(store.listRuns)).toEqual([])
  })

  it('persists a version string but returns a real SemVer domain value', async () => {
    await seed()
    const row = await database
      .prepare('SELECT workflow_version FROM runs WHERE run_id = ?')
      .bind('run_00000000-0000-4000-8000-000000000001')
      .first<{ workflow_version: string }>()
    expect(row?.workflow_version).toBe('1.0.0')
    const restored = await Effect.runPromise(makeD1Store(database).getRun('run_00000000-0000-4000-8000-000000000001'))
    expect(SemVer.isSemVer(restored.workflowVersion)).toBe(true)
    expect(SemVer.equals(restored.workflowVersion, version1)).toBe(true)
  })

  it('persists timestamp strings and nullable SQL node identity but restores DateTime and event variants', async () => {
    await seed()
    const eventId = 'event_00000000-0000-4000-8000-000000000002'
    const runEvent = { eventId, type: 'run.started', payload: {}, createdAt: now } as const
    await Effect.runPromise(store.commit(command({ events: [runEvent, ...command().events] })))
    const row = await database
      .prepare('SELECT created_at, updated_at FROM runs WHERE run_id = ?')
      .bind(command().runId)
      .first()
    expect(row).toEqual({ created_at: DateTime.formatIso(now), updated_at: DateTime.formatIso(now) })
    const physical = await database
      .prepare('SELECT node_id, execution_id, attempt, created_at FROM run_events WHERE event_id = ?')
      .bind(eventId)
      .first()
    expect(physical).toEqual({ node_id: null, execution_id: null, attempt: null, created_at: DateTime.formatIso(now) })
    const restored = makeD1Store(database)
    expect(await Effect.runPromise(restored.getRun(command().runId))).toMatchObject({ createdAt: now, updatedAt: now })
    expect(await Effect.runPromise(restored.getEvents(command().runId, { _tag: 'All' }))).toEqual([
      { ...runEvent, runId: command().runId, sequence: 1 },
      { ...Array.getUnsafe(command().events, 0), runId: command().runId, sequence: 2 },
    ])
  })

  it('rejects an obsolete persisted version instead of normalizing it', async () => {
    await seed()
    // Corrupt only this isolated database to exercise the read boundary beyond immutable-write guards.
    await database.prepare('DROP TRIGGER run_identity_immutable').run()
    await database
      .prepare('INSERT INTO workflow_versions (workflow_id, version, graph_id) VALUES (?, ?, ?)')
      .bind('demo', 'v1', demoGraph(version1).graphId)
      .run()
    await database
      .prepare('UPDATE runs SET workflow_version = ? WHERE run_id = ?')
      .bind('v1', 'run_00000000-0000-4000-8000-000000000001')
      .run()
    await expect(Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).rejects.toMatchObject({
      _tag: 'ExternalError',
      kind: 'storage',
    })
  })

  it.each([
    { commitId: '00000000-0000-4000-8000-000000000001' },
    { runId: '00000000-0000-4000-8000-000000000001' },
    { events: [{ ...Array.getUnsafe(command().events, 0), eventId: 'event-1' }] },
    { events: [{ ...Array.getUnsafe(command().events, 0), nodeId: '../prepare' }] },
    {
      events: [
        { ...Array.getUnsafe(command().events, 0), executionId: 'command_00000000-0000-4000-8000-000000000001' },
      ],
    },
  ])('rejects invalid commit identities atomically: %j', async (identity) => {
    await seed()
    const before = await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))
    await expect(Effect.runPromise(store.commit(command(identity)))).rejects.toMatchObject({
      _tag: 'ExternalError',
      kind: 'storage',
    })
    expect(await Effect.runPromise(store.getRun(before.runId))).toEqual(before)
    expect(await Effect.runPromise(store.getEvents(before.runId, { _tag: 'All' }))).toEqual([])
  })

  it('orders random run IDs by explicit creation time rather than ID value', async () => {
    const older = {
      ...newRun('run_ffffffff-ffff-4fff-8fff-ffffffffffff'),
      createdAt: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
    }
    const newer = {
      ...newRun('run_00000000-0000-4000-8000-000000000000'),
      createdAt: DateTime.makeUnsafe('2026-01-02T00:00:00.000Z'),
    }
    await Effect.runPromise(store.create(newer, demoGraph(version1), demoDefinition.summary.name))
    await Effect.runPromise(store.create(older, demoGraph(version1), demoDefinition.summary.name))
    expect(Array.map(await Effect.runPromise(store.listRuns), (run) => run.runId)).toEqual([newer.runId, older.runId])
  })

  it('rejects duplicate event IDs inside a new commit without changing receipts, state or events', async () => {
    await seed()
    const firstEvent = Array.getUnsafe(command().events, 0)
    await expect(
      Effect.runPromise(
        store.commit(
          command({
            events: [firstEvent, { ...firstEvent, payload: { changed: true } }],
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'Conflict' })
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toEqual(
      newRun('run_00000000-0000-4000-8000-000000000001'),
    )
    expect(
      await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
    ).toEqual([])
    expect(await Effect.runPromise(store.commit(command()))).toEqual({
      commitId: 'commit_00000000-0000-4000-8000-000000000001',
      runId: 'run_00000000-0000-4000-8000-000000000001',
      revision: 1,
      firstSequence: 1,
      eventCount: 1,
    })
  })

  it('persists run identity, graph and initial snapshot across store reconstruction', async () => {
    await seed()
    const restored = makeD1Store(database)
    expect(await Effect.runPromise(restored.getRun('run_00000000-0000-4000-8000-000000000001'))).toEqual(
      newRun('run_00000000-0000-4000-8000-000000000001'),
    )
    expect(await Effect.runPromise(restored.getGraph(demoGraph(version1).graphId))).toEqual(demoGraph(version1))
    expect(await Effect.runPromise(restored.listRuns)).toEqual([newRun('run_00000000-0000-4000-8000-000000000001')])
  })

  it('atomically commits snapshot revision and sequenced execution events before ACK', async () => {
    await seed()
    expect(await Effect.runPromise(store.commit(command()))).toEqual({
      commitId: 'commit_00000000-0000-4000-8000-000000000001',
      runId: 'run_00000000-0000-4000-8000-000000000001',
      revision: 1,
      firstSequence: 1,
      eventCount: 1,
    })
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      revision: 1,
      snapshot: command().snapshot,
      status: 'running',
    })
    expect(
      await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
    ).toEqual([
      { ...Array.getUnsafe(command().events, 0), runId: 'run_00000000-0000-4000-8000-000000000001', sequence: 1 },
    ])
  })

  it('returns the original ACK for exact duplicate deliveries without advancing revision', async () => {
    await seed()
    const first = await Effect.runPromise(store.commit(command()))
    expect(await Effect.runPromise(store.commit(command()))).toEqual(first)
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      revision: 1,
    })
    expect(
      await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
    ).toHaveLength(1)
  })

  it('returns an old duplicate ACK after later commits without replaying its snapshot', async () => {
    await seed()
    const first = await Effect.runPromise(store.commit(command()))
    await Effect.runPromise(
      store.commit(
        command({
          commitId: 'commit_00000000-0000-4000-8000-000000000002',
          expectedRevision: 1,
          status: 'waiting',
          snapshot: { checkpoint: 'later' },
          events: [],
        }),
      ),
    )
    expect(await Effect.runPromise(store.commit(command()))).toEqual(first)
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      revision: 2,
      snapshot: { checkpoint: 'later' },
    })
  })

  it('rejects reuse of a commit ID with a different event payload', async () => {
    await seed()
    await Effect.runPromise(store.commit(command()))
    await expect(Effect.runPromise(store.commit(command({ snapshot: { altered: true } })))).rejects.toMatchObject({
      _tag: 'Conflict',
    })
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      revision: 1,
      snapshot: command().snapshot,
    })
  })

  it('allows exactly one concurrent compare-and-swap winner', async () => {
    await seed()
    const results = await Effect.runPromise(
      Effect.all(
        [
          store.commit(command()).pipe(Effect.exit),
          store
            .commit(command({ commitId: 'commit_00000000-0000-4000-8000-000000000003', events: [] }))
            .pipe(Effect.exit),
        ],
        { concurrency: 'unbounded' },
      ),
    )
    expect(Array.filter(results, Exit.isSuccess)).toHaveLength(1)
    expect(Array.filter(results, Exit.isFailure)).toHaveLength(1)
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      revision: 1,
    })
  })

  it('rolls back receipt, snapshot and all events when a later event violates uniqueness', async () => {
    await seed()
    await Effect.runPromise(store.commit(command()))
    const duplicate = Array.getUnsafe(command().events, 0)
    await expect(
      Effect.runPromise(
        store.commit(
          command({
            commitId: 'commit_00000000-0000-4000-8000-000000000004',
            expectedRevision: 1,
            snapshot: { wrong: 'must roll back' },
            events: [{ ...duplicate, eventId: 'event_00000000-0000-4000-8000-000000000003' }, duplicate],
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'Conflict' })
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      revision: 1,
      snapshot: command().snapshot,
    })
    expect(
      await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
    ).toHaveLength(1)
    // The rejected receipt must not reserve its ID or revision.
    expect(
      await Effect.runPromise(
        store.commit(
          command({ commitId: 'commit_00000000-0000-4000-8000-000000000004', expectedRevision: 1, events: [] }),
        ),
      ),
    ).toMatchObject({ revision: 2 })
  })

  it('prevents all fresh commits after a run becomes terminal but still ACKs exact duplicates', async () => {
    await seed()
    const terminal = command({ status: 'completed', snapshot: { done: true } })
    const ack = await Effect.runPromise(store.commit(terminal))
    await expect(
      Effect.runPromise(
        store.commit(
          command({ commitId: 'commit_00000000-0000-4000-8000-000000000005', expectedRevision: 1, events: [] }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'Conflict' })
    expect(await Effect.runPromise(store.commit(terminal))).toEqual(ack)
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      status: 'completed',
      revision: 1,
    })
  })

  it('bounds event reads to the revision used for a detail snapshot', async () => {
    await seed()
    await Effect.runPromise(store.commit(command()))
    await Effect.runPromise(
      store.commit(
        command({
          commitId: 'commit_00000000-0000-4000-8000-000000000002',
          expectedRevision: 1,
          events: Array.map(command().events, (event) => ({
            ...event,
            eventId: 'event_00000000-0000-4000-8000-000000000002',
          })),
        }),
      ),
    )
    expect(
      await Effect.runPromise(
        store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'ThroughRevision', revision: 0 }),
      ),
    ).toEqual([])
    expect(
      await Effect.runPromise(
        store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'ThroughRevision', revision: 1 }),
      ),
    ).toHaveLength(1)
    expect(
      await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
    ).toHaveLength(2)
  })

  it('rejects graph ID reuse with different immutable graph content', async () => {
    await seed()
    await expect(
      Effect.runPromise(
        store.create(
          newRun('run_00000000-0000-4000-8000-000000000002'),
          { ...demoGraph(version1), nodes: [] },
          demoDefinition.summary.name,
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'Conflict' })
    expect(await Effect.runPromise(store.listRuns)).toHaveLength(1)
    expect(await Effect.runPromise(store.getGraph(demoGraph(version1).graphId))).toEqual(demoGraph(version1))
  })
})

describe('demo cold restoration', () => {
  it('generates prefixed UUIDv4 execution, event and commit identities and ACKs an exact duplicate commit', async () => {
    await seed()
    const persisted = store
    let commits: ReadonlyArray<CommitCommand> = []
    store = {
      ...persisted,
      commit: (input) => {
        commits = Array.append(commits, input)
        return persisted.commit(input)
      },
    }
    await run(startRun('run_00000000-0000-4000-8000-000000000001'))
    await run(resumeRun('run_00000000-0000-4000-8000-000000000001'))
    expect(Array.every(commits, (input) => Schema.is(CommitId)(input.commitId))).toBe(true)
    const events = await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' }))
    expect(Array.every(events, (event) => Schema.is(EventId)(event.eventId))).toBe(true)
    expect(Array.every(events, (event) => !('executionId' in event) || Schema.is(ExecutionId)(event.executionId))).toBe(
      true,
    )
    const first = Array.getUnsafe(commits, 0)
    const before = await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))
    expect(await Effect.runPromise(store.commit(first))).toMatchObject({ commitId: first.commitId, revision: 1 })
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toEqual(before)
    expect(
      await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
    ).toEqual(events)
  })

  it.each([version1, version2] as const)(
    'restores the waiting %s version in a new service and completes only after explicit resume',
    async (version) => {
      await seed('run_00000000-0000-4000-8000-000000000001', version)
      await run(startRun('run_00000000-0000-4000-8000-000000000001'))
      const waiting = await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))
      expect(waiting).toMatchObject({
        status: 'waiting',
        revision: 2,
        workflowVersion: version,
        snapshot: { _tag: 'Waiting', version: SemVer.format(version) },
      })
      store = makeD1Store(database)
      await run(startRun('run_00000000-0000-4000-8000-000000000001'))
      expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toEqual(waiting)
      await run(resumeRun('run_00000000-0000-4000-8000-000000000001'))
      const completed = await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))
      expect(completed).toMatchObject({
        status: 'completed',
        revision: 4,
        snapshot: {
          _tag: 'Completed',
          version: SemVer.format(version),
          result: SemVer.equals(version, version1) ? 'published:draft:v1' : 'published:draft:v2:reviewed',
        },
      })
      const events = await Effect.runPromise(
        store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' }),
      )
      expect(Array.map(events, (event) => event.sequence)).toEqual(Array.range(1, 10))
      expect(Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'prepare')).toHaveLength(
        1,
      )
      await expect(run(resumeRun('run_00000000-0000-4000-8000-000000000001'))).rejects.toMatchObject({
        _tag: 'InvalidOperation',
      })
      expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toEqual(completed)
    },
  )

  it('recovers a committed running prepare checkpoint without duplicating its start event', async () => {
    await seed()
    await Effect.runPromise(store.commit(command()))
    store = makeD1Store(database)
    await run(resumeRun('run_00000000-0000-4000-8000-000000000001'))
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      status: 'waiting',
      revision: 2,
    })
    expect(
      Array.filter(
        await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
        (event) => event.type === 'node.started' && event.nodeId === 'prepare',
      ),
    ).toHaveLength(1)
  })

  it('rejects malformed or version-mismatched restored state before executing a node', async () => {
    await seed()
    await Effect.runPromise(store.commit(command({ snapshot: { _tag: 'Preparing', version: 'v9' } })))
    await expect(run(resumeRun('run_00000000-0000-4000-8000-000000000001'))).rejects.toMatchObject({
      _tag: 'InvalidSnapshot',
    })
    expect(
      await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
    ).toHaveLength(1)
  })
})

describe('interrupted workflow recovery', () => {
  it('rejects an unregistered persisted workflow before dispatch without changing its checkpoint', async () => {
    const unsupported = { ...newRun('run_00000000-0000-4000-8000-000000000004'), workflowId: 'unregistered-workflow' }
    await Effect.runPromise(store.create(unsupported, demoGraph(version1), 'Unregistered workflow'))
    const resume = vi.fn(() => Effect.die('Unregistered workflows must not dispatch'))
    const binding = { start: resume, resume }
    const registry = [{ ...demoDefinition, binding }]
    await expect(
      Effect.runPromise(
        resumeWorkflowRun(unsupported.runId).pipe(
          Effect.provideService(Store, store),
          Effect.provideService(WorkflowRegistry, registry),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'InvalidOperation', message: 'The workflow is not registered' })
    expect(resume).not.toHaveBeenCalled()
    expect(await Effect.runPromise(store.getRun(unsupported.runId))).toEqual(unsupported)
    expect(await Effect.runPromise(store.getEvents(unsupported.runId, { _tag: 'All' }))).toEqual([])
  })

  it('restores a running publish checkpoint without replaying manual approval or node start', async () => {
    await seed()
    await run(startRun('run_00000000-0000-4000-8000-000000000001'))
    const persisted = store
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
    await expect(
      Effect.runPromise(
        resumeRun('run_00000000-0000-4000-8000-000000000001').pipe(
          Effect.provideService(Store, interrupted),
          Effect.provide(BrowserCrypto.layer),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'storage' })
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      revision: 3,
      status: 'running',
      snapshot: { _tag: 'Publishing', prepared: 'draft:v1' },
    })
    store = makeD1Store(database)
    await run(resumeRun('run_00000000-0000-4000-8000-000000000001'))
    const events = await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' }))
    expect(Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'publish')).toHaveLength(1)
    expect(
      Array.filter(events, (event) => event.type === 'node.succeeded' && event.nodeId === 'approval'),
    ).toHaveLength(1)
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toMatchObject({
      status: 'completed',
      revision: 4,
    })
    await expect(run(startRun('run_00000000-0000-4000-8000-000000000001'))).rejects.toMatchObject({
      _tag: 'InvalidOperation',
    })
  })

  it('leaves a recoverable pending run if its native static workflow RPC rejects', async () => {
    // Promise rejection is the native service-binding boundary wrapped by the production Alchemy client.
    const binding = makeRpcStub<WorkflowBinding['Service']>({
      start: () => Promise.reject(new Error('Individual worker disconnected')),
    })
    await expect(
      Effect.runPromise(
        createRun({ workflowId: 'demo', version: version1 }).pipe(
          Effect.provideService(Store, store),
          Effect.provideService(
            WorkflowRegistry,
            await Effect.runPromise(
              makeWorkflowRegistry.pipe(
                Effect.provideService(WorkflowBinding, binding),
                Effect.provide(unavailableDevelopmentBinding),
              ),
            ),
          ),
          Effect.provide(BrowserCrypto.layer),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'service' })
    const runs = await Effect.runPromise(store.listRuns)
    expect(runs).toHaveLength(1)
    const pending = Array.getUnsafe(runs, 0)
    expect(pending).toMatchObject({ status: 'pending', revision: 0 })
    await run(resumeRun(pending.runId))
    expect(await Effect.runPromise(store.getRun(pending.runId))).toMatchObject({ status: 'waiting', revision: 2 })
  })

  it('keeps the persisted checkpoint unchanged when an individual resume RPC rejects', async () => {
    await seed()
    await run(startRun('run_00000000-0000-4000-8000-000000000001'))
    const waiting = await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))
    const events = await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' }))
    const binding = makeRpcStub<WorkflowBinding['Service']>({
      resume: () => Promise.reject(new Error('Individual worker disconnected')),
    })
    await expect(
      Effect.runPromise(
        resumeWorkflowRun('run_00000000-0000-4000-8000-000000000001').pipe(
          Effect.provideService(Store, store),
          Effect.provideService(
            WorkflowRegistry,
            await Effect.runPromise(
              makeWorkflowRegistry.pipe(
                Effect.provideService(WorkflowBinding, binding),
                Effect.provide(unavailableDevelopmentBinding),
              ),
            ),
          ),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'service' })
    expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toEqual(waiting)
    expect(
      await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
    ).toEqual(events)
  })
})

describe('Effect HTTP API', () => {
  it('rejects bare UUIDv4 run IDs at persistence and HTTP boundaries', async () => {
    const id = '00000000-0000-4000-8000-000000000003'
    await expect(seed(id)).rejects.toMatchObject({ _tag: 'ExternalError' })
    expect(await Effect.runPromise(store.listRuns)).toEqual([])
    const handler = api()
    try {
      const read = await handler.handler(new Request(`http://localhost/api/runs/${id}`))
      expect(read.status).toBe(400)
      const resumed = await handler.handler(new Request(`http://localhost/api/runs/${id}/resume`, { method: 'POST' }))
      expect(resumed.status).toBe(400)
      expect(await Effect.runPromise(store.listRuns)).toEqual([])
    } finally {
      await handler.dispose()
    }
  })

  it('supports an arbitrary workflow through registry-only catalog, creation, detail and resume', async () => {
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
    const persist = vi.spyOn(store, 'create')
    const handler = api([
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
      expect(await catalog.json()).toEqual({ workflows: [{ ...summary, versions: [SemVer.format(version)] }] })
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
      const workflowRow = await database
        .prepare('SELECT name FROM workflows WHERE workflow_id = ?')
        .bind(summary.workflowId)
        .first<{ name: string }>()
      expect(workflowRow).toEqual({ name: summary.name })
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
      expect(await read.json()).toEqual(Schema.encodeSync(Schema.toCodecJson(RunDetail))(detail))
      const resumed = await handler.handler(
        new Request(`http://localhost/api/runs/${detail.run.runId}/resume`, { method: 'POST' }),
      )
      expect(resumed.status).toBe(200)
      expect(await resumed.json()).toEqual(Schema.encodeSync(Schema.toCodecJson(RunDetail))(detail))
      expect(resume).toHaveBeenCalledExactlyOnceWith(detail.run.runId)
    } finally {
      persist.mockRestore()
      await handler.dispose()
    }
  })

  it.each([
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
  ])('rejects invalid workflow-owned input before persistence: %j', async (input) => {
    const create = vi.spyOn(store, 'create')
    const handler = api()
    try {
      const response = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
      expect(response.status).toBe(400)
      expect(create).not.toHaveBeenCalled()
      expect(await Effect.runPromise(store.listRuns)).toEqual([])
    } finally {
      create.mockRestore()
      await handler.dispose()
    }
  })
  it('rejects browser-originated text/plain create requests without writing a run', async () => {
    const handler = api()
    try {
      const response = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
          body: '{"workflowId":"demo","version":"v1"}',
        }),
      )
      expect(response.status).toBe(403)
      expect(await Effect.runPromise(store.listRuns)).toEqual([])
    } finally {
      await handler.dispose()
    }
  })

  it('rejects browser-originated resume requests without advancing the persisted checkpoint', async () => {
    await seed()
    await run(startRun('run_00000000-0000-4000-8000-000000000001'))
    const waiting = await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))
    const events = await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' }))
    const handler = api()
    try {
      const response = await handler.handler(
        new Request('http://localhost/api/runs/run_00000000-0000-4000-8000-000000000001/resume', {
          method: 'POST',
          headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
        }),
      )
      expect(response.status).toBe(403)
      expect(await Effect.runPromise(store.getRun('run_00000000-0000-4000-8000-000000000001'))).toEqual(waiting)
      expect(
        await Effect.runPromise(store.getEvents('run_00000000-0000-4000-8000-000000000001', { _tag: 'All' })),
      ).toEqual(events)
    } finally {
      await handler.dispose()
    }
  })

  it('lists bundled workflows and validates the create boundary', async () => {
    const handler = api()
    try {
      const workflows = await handler.handler(new Request('http://localhost/api/workflows'))
      expect(workflows.status).toBe(200)
      expect(await workflows.json()).toEqual({
        workflows: [
          { workflowId: 'demo', name: 'Release checkpoint', versions: ['1.0.0', '2.0.0'], inputs: [] },
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
      })
      const invalid = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"workflowId":"demo","version":"v9"}',
        }),
      )
      expect(invalid.status).toBe(400)
      const unsafeId = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workflowId: '../demo', version: '1.0.0' }),
        }),
      )
      expect(unsafeId.status).toBe(400)
      expect(await Effect.runPromise(store.listRuns)).toEqual([])
    } finally {
      await handler.dispose()
    }
  })

  it.each(['1.0.0', '2.0.0'])(
    'creates, reads and resumes a persisted %s run, then protects the completed run',
    async (version) => {
      const handler = api()
      try {
        const created = await handler.handler(
          new Request('http://localhost/api/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflowId: 'demo', version }),
          }),
        )
        expect(created.status).toBe(201)
        const body = await Effect.runPromise(
          Schema.decodeUnknownEffect(Schema.toCodecJson(RunDetail))(await created.json()),
        )
        expect(Schema.is(RunId)(body.run.runId)).toBe(true)
        expect(body.run.status).toBe('waiting')
        const detail = await handler.handler(new Request(`http://localhost/api/runs/${body.run.runId}`))
        expect(detail.status).toBe(200)
        expect(await detail.json()).toMatchObject({
          run: { status: 'waiting' },
          state: { revision: 2 },
          shapes: { nodes: [{ state: 'succeeded' }, { state: 'waiting' }, { state: 'idle' }] },
        })
        const listed = await handler.handler(new Request('http://localhost/api/runs'))
        expect(listed.status).toBe(200)
        expect(await listed.json()).toEqual(Schema.encodeSync(Schema.toCodecJson(RunsResponse))({ runs: [body.run] }))
        const resumed = await handler.handler(
          new Request(`http://localhost/api/runs/${body.run.runId}/resume`, { method: 'POST' }),
        )
        expect(resumed.status).toBe(200)
        expect(await resumed.json()).toMatchObject({
          run: { status: 'completed', workflowVersion: version },
          state: { revision: 4 },
        })
        const again = await handler.handler(
          new Request(`http://localhost/api/runs/${body.run.runId}/resume`, { method: 'POST' }),
        )
        expect(again.status).toBe(409)
      } finally {
        await handler.dispose()
      }
    },
  )

  it('returns 404 for a missing persisted run', async () => {
    const handler = api()
    try {
      const response = await handler.handler(
        new Request('http://localhost/api/runs/run_00000000-0000-4000-8000-000000000005'),
      )
      expect(response.status).toBe(404)
    } finally {
      await handler.dispose()
    }
  })
})
