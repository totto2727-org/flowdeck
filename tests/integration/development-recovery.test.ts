import { live } from '@effect/vitest'
import { Array, Effect, Option } from 'effect'
import { expect } from 'vite-plus/test'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import type { Run } from '@/core/feature/workflow/domain/model'
import type { StoreService } from '@/core/feature/workflow/services/store'
import { resumeDevelopmentRun, startDevelopmentRun } from '@/user-land/workflow/development/feature/development'
import { DevelopmentStates } from '@/user-land/workflow/development/feature/development-machine'

import { openDevelopmentFixture } from './development-d1.fixture.ts'
import { activeOf, failedOf, matches, nativeSnapshot } from './development-snapshot.fixture.ts'

type Fixture = Effect.Success<typeof openDevelopmentFixture>
const firstSubmission = 0
const terminalFailureEvents = 2

const offline = (): Effect.Effect<never, ExternalError> =>
  Effect.fail(new ExternalError({ cause: 'offline', kind: 'service', operation: 'test binding' }))

const rejectCommit = (): Effect.Effect<never, ExternalError> =>
  Effect.fail(new ExternalError({ cause: 'unavailable', kind: 'storage', operation: 'test checkpoint failure' }))

const rejectingStatus = (store: StoreService, status: Run['status']): StoreService => ({
  ...store,
  commit: (command) => (command.status === status ? rejectCommit() : store.commit(command)),
})

const firstCommandId = ({ pi }: Fixture): Parameters<Fixture['pi']['setReceipt']>[1]['commandId'] => {
  const { input } = Array.getUnsafe(pi.read().submissions, firstSubmission)
  return input.commandId
}

const startedVerification = Effect.fn('flowdeck.test.prepareVerification')(function* ({ pi, resume, start }: Fixture) {
  yield* start
  pi.finishTurn('implement')
  yield* resume
  pi.finishTurn('verify')
})

const failureType = (failure: unknown): 'service' | 'storage' | undefined =>
  failure instanceof ExternalError ? failure.kind : undefined

live.each(['failed', 'interrupted'] as const)(
  'commits a %s receipt as a business failure and retains the container',
  (status) =>
    Effect.gen(function* () {
      const fixture = yield* openDevelopmentFixture
      yield* fixture.start
      const commandId = firstCommandId(fixture)
      const error = status === 'failed' ? 'sdk_failure' : 'runtime_interrupted'
      fixture.pi.setReceipt(commandId, { commandId, error, status })
      yield* fixture.resume
      const persisted = yield* fixture.current
      const last = Array.takeRight(yield* fixture.events, terminalFailureEvents)
      expect({
        completeCalls: fixture.pi.read().completeCalls,
        eventTypes: Array.map(last, (event) => event.type),
        nodeId: (yield* failedOf(persisted.snapshot)).nodeId,
        status: persisted.status,
        turns: Array.length(fixture.pi.read().submissions),
      }).toStrictEqual({
        completeCalls: [],
        eventTypes: ['node.failed', 'run.failed'],
        nodeId: 'implement',
        status: 'failed',
        turns: 1,
      })
    }).pipe(Effect.scoped),
)

live('never resubmits an acknowledged operation whose receipt disappears', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    yield* fixture.start
    fixture.pi.clearReceipts()
    yield* fixture.resume
    const persisted = yield* fixture.current
    expect(persisted.status).toBe('failed')
    expect((yield* failedOf(persisted.snapshot)).message).toContain('will not be resubmitted')
    expect(fixture.pi.read().submissions).toHaveLength(1)
  }).pipe(Effect.scoped),
)

live('recovers accepted submit after the Waiting checkpoint fails without another submission', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    const start = fixture.execute(startDevelopmentRun(fixture.initial.runId), rejectingStatus(fixture.store, 'waiting'))
    expect(failureType(yield* Effect.flip(start))).toBe('storage')
    expect(yield* matches((yield* fixture.current).snapshot, 'implement.intent')).toBe(true)
    yield* fixture.resume
    expect(yield* matches((yield* fixture.current).snapshot, 'implement.awaiting')).toBe(true)
    expect(fixture.pi.read().submissions).toHaveLength(1)
    const events = yield* fixture.events
    expect(Array.filter(events, (event) => event.type === 'node.started')).toHaveLength(1)
  }).pipe(Effect.scoped),
)

const interruptedSession = Effect.fn('flowdeck.test.failDevelopmentEnsure')(function* (fixture: Fixture) {
  const original = fixture.pi.sandbox()
  fixture.pi.setSandbox({ ...original, ensureSession: offline })
  const failed = yield* Effect.flip(fixture.start)
  const { snapshot } = yield* fixture.current
  const state = fixture.pi.read()
  fixture.pi.setSandbox(original)
  return { failed, snapshot, submissions: state.submissions }
})

live('recovers session initialization failure with one stable command and execution identity', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    const { failed, snapshot, submissions } = yield* interruptedSession(fixture)
    const before = yield* activeOf(snapshot)
    expect(submissions).toStrictEqual([])
    expect({ error: failureType(failed), intent: yield* matches(snapshot, 'implement.intent') }).toStrictEqual({
      error: 'service',
      intent: true,
    })
    yield* fixture.resume
    const { snapshot: after } = yield* fixture.current
    expect(yield* activeOf(after)).toMatchObject({ commandId: before.commandId, executionId: before.executionId })
    expect(fixture.pi.read().submissions).toHaveLength(1)
    expect(Array.filter(yield* fixture.events, (event) => event.type === 'node.started')).toHaveLength(1)
  }).pipe(Effect.scoped),
)

live('fails closed when verification finds an already completed session', () =>
  Effect.gen(function* () {
    const { current, pi, resume, start } = yield* openDevelopmentFixture
    yield* start
    pi.finishTurn('implement')
    pi.setSession({ ...pi.read().session, status: 'completed' })
    yield* resume
    const failure = yield* failedOf((yield* current).snapshot)
    expect({
      messageMatches: failure.message.includes('original active Pi session'),
      nodeId: failure.nodeId,
    }).toStrictEqual({ messageMatches: true, nodeId: 'verify' })
    expect(pi.read().submissions).toHaveLength(1)
    expect(pi.read().completeCalls).toStrictEqual([])
  }).pipe(Effect.scoped),
)

live('recovers acknowledged completion after terminal checkpoint failure without another turn', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    yield* startedVerification(fixture)
    const patched = rejectingStatus(fixture.store, 'completed')
    const resume = fixture.execute(resumeDevelopmentRun(fixture.initial.runId), patched)
    expect({
      failure: failureType(yield* Effect.flip(resume)),
      session: fixture.pi.read().session.status,
      state: yield* matches((yield* fixture.current).snapshot, 'verify.completing'),
    }).toStrictEqual({ failure: 'storage', session: 'completed', state: true })
    yield* fixture.resume
    const { status } = yield* fixture.current
    expect({ status, turns: Array.length(fixture.pi.read().submissions) }).toStrictEqual({
      status: 'completed',
      turns: 2,
    })
    expect(Array.filter(yield* fixture.events, (event) => event.type === 'run.completed')).toHaveLength(1)
  }).pipe(Effect.scoped),
)

const interruptCompletion = Effect.fn('flowdeck.test.interruptDevelopmentComplete')(function* (fixture: Fixture) {
  const original = fixture.pi.sandbox()
  fixture.pi.setSandbox({ ...original, complete: offline })
  const failure = yield* Effect.flip(fixture.resume)
  const persisted = yield* fixture.current
  fixture.pi.setSandbox({
    ...original,
    getTurn: () => Effect.die('Completion recovery must not poll a finished operation'),
  })
  return { failure, persisted }
})

live('recovers completion transport failure from durable result without polling or resubmitting', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    yield* startedVerification(fixture)
    const { failure, persisted } = yield* interruptCompletion(fixture)
    const native = yield* nativeSnapshot(persisted.snapshot)
    const progress = Option.getOrThrow(DevelopmentStates.get(native, 'verify.completing'))
    expect({
      failure: failureType(failure),
      result: progress.result,
      state: DevelopmentStates.matches(native, 'verify.completing'),
    }).toStrictEqual({ failure: 'service', result: 'verify result', state: true })
    yield* fixture.resume
    expect((yield* fixture.current).status).toBe('completed')
    expect({
      calls: fixture.pi.read().completeCalls,
      turns: Array.length(fixture.pi.read().submissions),
    }).toStrictEqual({ calls: [fixture.initial.runId], turns: 2 })
  }).pipe(Effect.scoped),
)

live('rejects a receipt with a different command identity without submitting again', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    yield* fixture.start
    fixture.pi.setReceipt(firstCommandId(fixture), {
      commandId: 'command_00000000-0000-4000-8000-000000000099',
      status: 'completed',
      text: 'wrong operation',
    })
    yield* fixture.resume
    const result = yield* fixture.current
    expect(result.status).toBe('failed')
    expect((yield* failedOf(result.snapshot)).message).toContain('different command identity')
    expect(fixture.pi.read().submissions).toHaveLength(1)
  }).pipe(Effect.scoped),
)

live('fails when Pi completion is not acknowledged after verification', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    yield* startedVerification(fixture)
    fixture.pi.setSandbox({
      ...fixture.pi.sandbox(),
      complete: () => Effect.succeed(fixture.pi.read().session),
    })
    yield* fixture.resume
    expect((yield* failedOf((yield* fixture.current).snapshot)).nodeId).toBe('verify')
    expect(fixture.pi.read().completeCalls).toStrictEqual([])
  }).pipe(Effect.scoped),
)

live('recovers submit rejected before acceptance using the original command ID', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    const sandbox = fixture.pi.sandbox()
    fixture.pi.setSandbox({ ...sandbox, submitTurn: offline })
    expect(failureType(yield* Effect.flip(fixture.start))).toBe('service')
    const { snapshot } = yield* fixture.current
    const pending = yield* activeOf(snapshot)
    fixture.pi.setSandbox(sandbox)
    yield* fixture.resume
    expect(fixture.pi.read().submissions).toHaveLength(1)
    expect(firstCommandId(fixture)).toBe(pending.commandId)
  }).pipe(Effect.scoped),
)

live('prevents initialization and submission when the intent checkpoint rejects', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    const store = { ...fixture.store, commit: rejectCommit }
    const start = fixture.execute(startDevelopmentRun(fixture.initial.runId), store)
    expect(failureType(yield* Effect.flip(start))).toBe('storage')
    expect(fixture.pi.read()).toMatchObject({ ensureCalls: 0, submissions: [] })
    expect(yield* fixture.current).toStrictEqual(fixture.initial)
  }).pipe(Effect.scoped),
)
