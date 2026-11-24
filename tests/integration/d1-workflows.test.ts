import { live } from '@effect/vitest'
import { Array, DateTime, Effect, Exit, SemVer } from 'effect'
import { describe, expect } from 'vite-plus/test'

import { EventRange } from '@/core/feature/workflow/services/store'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'
import { demoGraph } from '@/user-land/workflow/demo/feature/demo'

import { command, d1Fixture, newRun, now, version1 } from './d1-workflows.fixture.ts'

describe('D1 persisted run store', () => {
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
