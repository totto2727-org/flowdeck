import { live } from '@effect/vitest'
import { Array, Effect, Exit } from 'effect'
import { expect } from 'vite-plus/test'

import { StorageConflict } from '@/core/feature/workflow/domain/errors'
import { EventRange } from '@/core/feature/workflow/services/store'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'
import { demoGraph } from '@/user-land/workflow/demo/feature/demo'

import { command, d1Fixture, newRun, version1 } from './d1-workflows.fixture.ts'

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
    expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toStrictEqual([
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
    expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toHaveLength(1)
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
        events: [],
        expectedRevision: 1,
        snapshot: { checkpoint: 'later' },
        status: 'waiting',
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
    const changed = command({ snapshot: { altered: true } })
    const failure = yield* fixture.store.commit(changed).pipe(Effect.flip)
    expect(failure).toBeInstanceOf(StorageConflict)
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
    const rejected = command({
      commitId: 'commit_00000000-0000-4000-8000-000000000004',
      events: [{ ...duplicate, eventId: 'event_00000000-0000-4000-8000-000000000003' }, duplicate],
      expectedRevision: 1,
      snapshot: { wrong: 'must roll back' },
    })
    const failure = yield* fixture.store.commit(rejected).pipe(Effect.flip)
    expect(failure).toBeInstanceOf(StorageConflict)
    expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
      revision: 1,
      snapshot: command().snapshot,
    })
    expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toHaveLength(1)
    // The rejected receipt must not reserve its ID or revision.
    expect(
      yield* fixture.store.commit(
        command({ commitId: 'commit_00000000-0000-4000-8000-000000000004', events: [], expectedRevision: 1 }),
      ),
    ).toMatchObject({ revision: 2 })
  }),
)

live('prevents all fresh commits after a run becomes terminal but still ACKs exact duplicates', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect()
    const terminal = command({ snapshot: { done: true }, status: 'completed' })
    const ack = yield* fixture.store.commit(terminal)
    const fresh = command({
      commitId: 'commit_00000000-0000-4000-8000-000000000005',
      events: [],
      expectedRevision: 1,
    })
    const failure = yield* fixture.store.commit(fresh).pipe(Effect.flip)
    expect(failure).toBeInstanceOf(StorageConflict)
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
    const laterEvents = Array.map(command().events, (event) => ({
      ...event,
      eventId: 'event_00000000-0000-4000-8000-000000000002',
    }))
    yield* fixture.store.commit(
      command({
        commitId: 'commit_00000000-0000-4000-8000-000000000002',
        events: laterEvents,
        expectedRevision: 1,
      }),
    )
    expect(
      yield* fixture.store.getEvents(
        'run_00000000-0000-4000-8000-000000000001',
        EventRange.ThroughRevision({ revision: 0 }),
      ),
    ).toStrictEqual([])
    expect(
      yield* fixture.store.getEvents(
        'run_00000000-0000-4000-8000-000000000001',
        EventRange.ThroughRevision({ revision: 1 }),
      ),
    ).toHaveLength(1)
    expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toHaveLength(2)
  }),
)

live('rejects graph ID reuse with different immutable graph content', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect()
    const run = yield* newRun('run_00000000-0000-4000-8000-000000000002')
    const graph = { ...demoGraph(version1), nodes: [] }
    const create = fixture.store.create(run, graph, demoDefinition.summary.name)
    expect(yield* Effect.flip(create)).toBeInstanceOf(StorageConflict)
    expect(yield* fixture.store.listRuns).toHaveLength(1)
    expect(yield* fixture.store.getGraph(demoGraph(version1).graphId)).toStrictEqual(demoGraph(version1))
  }),
)
