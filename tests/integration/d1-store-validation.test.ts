import { live } from '@effect/vitest'
import { Array, DateTime, Effect, Predicate, SemVer } from 'effect'
import { expect } from 'vite-plus/test'

import { Conflict, ExternalError, StorageConflict } from '@/core/feature/workflow/domain/errors'
import { EventRange } from '@/core/feature/workflow/services/store'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'
import { demoGraph } from '@/user-land/workflow/demo/feature/demo'

import { command, d1Fixture, newRun, now, version1 } from './d1-workflows.fixture.ts'

// oxlint-disable-next-line unicorn/no-null -- The D1 driver returns SQL NULL as JavaScript null.
const sqlNull = null

live('retains the original D1 constraint failure and stack for upstream logging', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect()
    yield* fixture.store.commit(command())
    const error = yield* fixture.store.commit(command({ snapshot: { changed: true } })).pipe(Effect.flip)
    expect(error).toBeInstanceOf(StorageConflict)
    const cause = Predicate.hasProperty(error, 'cause') ? error.cause : undefined
    expect(Predicate.hasProperty(cause, 'message') && cause.message).toContain('flowdeck_')
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
    const run = yield* newRun('run_00000000-0000-4000-8000-000000000001')
    const graph = demoGraph(version1)
    const create = fixture.store.create({ ...run, ...identity }, graph, demoDefinition.summary.name)
    const failure = yield* Effect.flip(create)
    expect(failure).toBeInstanceOf(ExternalError)
    expect(failure).toHaveProperty('kind', 'storage')
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

const runEvent = {
  createdAt: now,
  eventId: 'event_00000000-0000-4000-8000-000000000002',
  payload: {},
  type: 'run.started',
} as const
const timedCommit = command({ events: [runEvent, ...command().events] })

live('persists timestamp strings and nullable event identity in D1', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect()
    yield* fixture.store.commit(timedCommit)
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
        .bind(runEvent.eventId)
        .first(),
    )
    expect(physical).toStrictEqual({
      attempt: sqlNull,
      created_at: DateTime.formatIso(now),
      execution_id: sqlNull,
      node_id: sqlNull,
    })
  }),
)

live('restores DateTime and event variants through a new D1 store', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect()
    yield* fixture.store.commit(timedCommit)
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
    const lookup = fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
    const failure = yield* Effect.flip(lookup)
    expect(failure).toBeInstanceOf(ExternalError)
    expect(failure).toHaveProperty('kind', 'storage')
  }),
)

live.each([
  { commitId: '00000000-0000-4000-8000-000000000001' },
  { runId: '00000000-0000-4000-8000-000000000001' },
  { events: [{ ...Array.getUnsafe(command().events, 0), eventId: 'event-1' }] },
  { events: [{ ...Array.getUnsafe(command().events, 0), nodeId: '../prepare' }] },
  {
    events: [{ ...Array.getUnsafe(command().events, 0), executionId: 'command_00000000-0000-4000-8000-000000000001' }],
  },
])('rejects invalid commit identities atomically: %j', (identity) =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect()
    const before = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
    const commit = fixture.store.commit(command(identity))
    const failure = yield* Effect.flip(commit)
    expect(failure).toBeInstanceOf(ExternalError)
    expect(failure).toHaveProperty('kind', 'storage')
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
    const duplicate = command({ events: [firstEvent, { ...firstEvent, payload: { changed: true } }] })
    const failure = yield* fixture.store.commit(duplicate).pipe(Effect.flip)
    expect(failure).toBeInstanceOf(Conflict)
    expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(
      yield* newRun('run_00000000-0000-4000-8000-000000000001'),
    )
    expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toStrictEqual(
      [],
    )
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
