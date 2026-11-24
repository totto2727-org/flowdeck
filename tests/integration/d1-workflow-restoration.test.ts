import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { Array, Data, Effect, Layer, Ref, Schema, SemVer } from 'effect'
import { TestCrypto } from 'effect/testing'
import { expect } from 'vite-plus/test'

import { ExternalError, InvalidOperation, InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { CommitId, EventId, ExecutionId } from '@/core/feature/workflow/domain/identity'
import { EventRange, Store } from '@/core/feature/workflow/services/store'
import type { CommitCommand, StoreService } from '@/core/feature/workflow/services/store'
import { makeDemoExecutor, resumeRun, startRun } from '@/user-land/workflow/demo/feature/demo'

import { command, d1Fixture, version1, version2 } from './d1-workflows.fixture.ts'

const { runId } = command()
const versions = [version1, version2] as const
const isCommitId = Schema.is(CommitId)
const isEventId = Schema.is(EventId)
const isExecutionId = Schema.is(ExecutionId)
const allEvents = EventRange.All()
const testCrypto = TestCrypto.layer('captured-demo-executor').pipe(Layer.provide(BrowserCrypto.layer))

live.each(versions)('captures demo dependencies once and executes %s without a caller context', (version) =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect(runId, version)
    const services = Layer.mergeAll(Layer.succeed(Store, fixture.store), testCrypto)
    const executor = yield* makeDemoExecutor.pipe(Effect.provide(services))
    yield* executor.start(runId)
    const reopened = yield* fixture.freshStore
    expect(yield* reopened.getRun(runId)).toMatchObject({ revision: 2, status: 'waiting' })
    yield* executor.resume(runId)
    expect(yield* reopened.getRun(runId)).toMatchObject({ revision: 4, status: 'completed' })
    expect(yield* fixture.store.getEvents(runId, allEvents)).toHaveLength(10)
  }),
)

const completedWithCommits = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  yield* fixture.seedEffect()
  const commits = yield* Ref.make<Readonly<CommitCommand[]>>([])
  const persisted = fixture.store
  fixture.store = {
    ...persisted,
    commit: (input) => {
      const remember = Ref.update(commits, (prior) => Array.append(prior, input))
      return Effect.andThen(remember, () => persisted.commit(input))
    },
  }
  yield* fixture.provideTestServices(startRun(runId))
  yield* fixture.provideTestServices(resumeRun(runId))
  return { commits: yield* Ref.get(commits), store: fixture.store }
})

live('generates prefixed UUIDv4 execution, event and commit identities', () =>
  Effect.gen(function* () {
    const { commits, store } = yield* completedWithCommits
    const events = yield* store.getEvents(runId, allEvents)
    expect(Array.every(commits, (input) => isCommitId(input.commitId))).toBe(true)
    expect(Array.every(events, (event) => isEventId(event.eventId))).toBe(true)
    expect(Array.every(events, (event) => !('executionId' in event) || isExecutionId(event.executionId))).toBe(true)
  }),
)

live('returns the original ACK for a duplicate commit after restoring a completed workflow', () =>
  Effect.gen(function* () {
    const { commits, store } = yield* completedWithCommits
    const first = Array.getUnsafe(commits, 0)
    const checkpoint = Effect.all({ events: store.getEvents(runId, allEvents), run: store.getRun(runId) })
    const before = yield* checkpoint
    expect(yield* store.commit(first)).toMatchObject({ commitId: first.commitId, revision: 1 })
    expect(yield* checkpoint).toStrictEqual(before)
  }),
)

const waitingCheckpoint = Effect.fn('flowdeck.test.waitingCheckpoint')(function* (version: (typeof versions)[number]) {
  const fixture = yield* d1Fixture
  yield* fixture.seedEffect(runId, version)
  yield* fixture.provideTestServices(startRun(runId))
  const waiting = yield* fixture.store.getRun(runId)
  fixture.store = yield* fixture.freshStore
  return { fixture, waiting }
})

live.each(versions)('leaves the waiting %s checkpoint unchanged when start is repeated after restoration', (version) =>
  Effect.gen(function* () {
    const { fixture, waiting } = yield* waitingCheckpoint(version)
    expect(waiting).toMatchObject({
      revision: 2,
      snapshot: { machine: { active: [{ path: '' }, { path: 'approval' }] }, version: SemVer.format(version) },
      status: 'waiting',
      workflowVersion: version,
    })
    yield* fixture.provideTestServices(startRun(runId))
    expect(yield* fixture.store.getRun(runId)).toStrictEqual(waiting)
  }),
)

live.each(versions)(
  'resumes the waiting %s checkpoint and retains its terminal state after duplicate resume',
  (version) =>
    Effect.gen(function* () {
      const { fixture } = yield* waitingCheckpoint(version)
      yield* fixture.provideTestServices(resumeRun(runId))
      const completed = yield* fixture.store.getRun(runId)
      const expectedResult = SemVer.equals(version, version1) ? 'published:draft:v1' : 'published:draft:v2:reviewed'
      expect(completed).toMatchObject({
        revision: 4,
        snapshot: {
          machine: { active: [{ path: '' }, { path: 'completed', value: { result: expectedResult } }] },
          version: SemVer.format(version),
        },
        status: 'completed',
      })
      const events = yield* fixture.store.getEvents(runId, allEvents)
      expect({
        prepareStarts: Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'prepare')
          .length,
        sequence: Array.map(events, (event) => event.sequence),
      }).toStrictEqual({ prepareStarts: 1, sequence: Array.range(1, 10) })
      const resumeAgain = fixture.provideTestServices(resumeRun(runId))
      expect(yield* Effect.flip(resumeAgain)).toBeInstanceOf(InvalidOperation)
      expect(yield* fixture.store.getRun(runId)).toStrictEqual(completed)
    }),
)

const losePrepareAck = (persisted: StoreService): StoreService => {
  const lost = new ExternalError({
    cause: 'test transport loss',
    kind: 'storage',
    operation: 'lost prepare checkpoint ACK',
  })
  return {
    ...persisted,
    commit: (input) => persisted.commit(input).pipe(Effect.andThen(Effect.fail(lost))),
  }
}

const committedPrepare = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  yield* fixture.seedEffect()
  const persisted = fixture.store
  fixture.store = losePrepareAck(persisted)
  const start = fixture.provideTestServices(startRun(runId))
  const failure = yield* Effect.flip(start)
  fixture.store = yield* fixture.freshStore
  return { failure, fixture, persisted }
})

live('retains the prepared write when its acknowledgement is lost', () =>
  Effect.gen(function* () {
    const { failure, persisted } = yield* committedPrepare
    expect(failure).toBeInstanceOf(ExternalError)
    expect(yield* persisted.getRun(runId)).toMatchObject({ revision: 1, status: 'running' })
    expect(yield* persisted.getEvents(runId, allEvents)).toHaveLength(2)
  }),
)

live('recovers a committed prepare checkpoint without duplicating its start event', () =>
  Effect.gen(function* () {
    const { fixture } = yield* committedPrepare
    yield* fixture.provideTestServices(resumeRun(runId))
    expect(yield* fixture.store.getRun(runId)).toMatchObject({ revision: 2, status: 'waiting' })
    const events = yield* fixture.store.getEvents(runId, allEvents)
    expect(Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'prepare')).toHaveLength(1)
  }),
)

const obsoleteSnapshot = Data.taggedEnum<
  Data.TaggedEnum<{
    Preparing: { version: string }
  }>
>().Preparing({ version: 'v9' })

live('rejects malformed or version-mismatched restored state before executing a node', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect()
    yield* fixture.store.commit(command({ snapshot: obsoleteSnapshot }))
    const resume = fixture.provideTestServices(resumeRun(runId))
    expect(yield* Effect.flip(resume)).toBeInstanceOf(InvalidSnapshot)
    expect(yield* fixture.store.getEvents(runId, allEvents)).toHaveLength(1)
  }),
)
