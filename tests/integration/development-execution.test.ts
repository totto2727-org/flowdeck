import { live } from '@effect/vitest'
import { Array, DateTime, Effect, MutableRef, Option, Schema } from 'effect'
import { expect } from 'vite-plus/test'

import { CommandId } from '@/core/feature/pi/model'
import { ExternalError, InvalidOperation } from '@/core/feature/workflow/domain/errors'
import { CommitId, EventId, ExecutionId } from '@/core/feature/workflow/domain/identity'
import { makeDevelopmentExecutor, startDevelopmentRun } from '@/user-land/workflow/development/feature/development'
import { DevelopmentStates } from '@/user-land/workflow/development/feature/development-machine'

import { openDevelopmentFixture } from './development-d1.fixture.ts'
import { activeOf, developmentInput, matches, nativeSnapshot } from './development-snapshot.fixture.ts'

type Fixture = Effect.Success<typeof openDevelopmentFixture>
const firstTurn = 0
const verificationTurn = 1
const firstRunEvent = 0
const waitingEvent = 2
const firstVerificationEvent = 0
const secondVerificationEvent = 1
const firstAttempt = 1

const offline = (): Effect.Effect<never, ExternalError> =>
  Effect.fail(new ExternalError({ cause: 'offline', kind: 'service', operation: 'test binding' }))
const unavailableHarness = { complete: offline, ensureSession: offline, getTurn: offline, submitTurn: offline }

const finishVerification = Effect.fn('flowdeck.test.finishVerification')(function* ({ pi, resume, start }: Fixture) {
  yield* start
  pi.finishTurn('implement')
  yield* resume
  pi.finishTurn('verify')
  yield* resume
})

const capturedProgress = Effect.fn('flowdeck.test.capturedDevelopmentProgress')(function* (fixture: Fixture) {
  const executor = yield* fixture.execute(makeDevelopmentExecutor)
  const { runId } = fixture.initial
  fixture.pi.setSandbox(unavailableHarness)
  yield* executor.start(runId)
  const implementation = yield* fixture.current
  const finish = (node: Parameters<Fixture['pi']['finishTurn']>[0]): ReturnType<typeof executor.resume> =>
    Effect.sync(() => {
      fixture.pi.finishTurn(node)
    }).pipe(Effect.andThen(executor.resume(runId)))
  yield* finish('implement')
  const verification = yield* fixture.current
  yield* finish('verify')
  return { implementation, verification }
})

live('captures stable provider dependencies once and completes without caller context', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    const { implementation, verification } = yield* capturedProgress(fixture)
    expect(yield* matches(implementation.snapshot, 'implement.awaiting')).toBe(true)
    expect(yield* matches(verification.snapshot, 'verify.awaiting')).toBe(true)
    expect((yield* fixture.current).status).toBe('completed')
    expect(fixture.pi.read().submissions).toHaveLength(2)
    expect(fixture.pi.read().completeCalls).toStrictEqual([fixture.initial.runId])
  }).pipe(Effect.scoped),
)

const checkIntentBeforeInitialization = (fixture: Fixture): void => {
  const sandbox = fixture.pi.sandbox()
  fixture.pi.setSandbox({
    ...sandbox,
    ensureSession: Effect.fn('flowdeck.test.checkIntentBeforeEnsure')(
      function* (runId) {
        const persisted = yield* fixture.store.getRun(runId)
        const waiting = yield* matches(persisted.snapshot, 'implement.intent')
        const { commandId } = yield* activeOf(persisted.snapshot)
        if (!waiting || !Schema.is(CommandId)(commandId)) {
          return yield* new ExternalError({
            cause: 'Pi setup requires a persisted intent with a stable command identity.',
            kind: 'service',
            operation: 'test ensure',
          })
        }
        return yield* sandbox.ensureSession(runId)
      },
      Effect.mapError((cause) => new ExternalError({ cause, kind: 'service', operation: 'test ensure' })),
    ),
  })
}

const captureCommitIds = Effect.fn('flowdeck.test.captureDevelopmentCommitIds')(function* (fixture: Fixture) {
  const ids = MutableRef.make<Readonly<string[]>>([])
  const { store } = fixture
  yield* fixture.execute(startDevelopmentRun(fixture.initial.runId), {
    ...store,
    commit: (command) => {
      MutableRef.update(ids, (previous) => Array.append(previous, command.commitId))
      return store.commit(command)
    },
  })
  return MutableRef.get(ids)
})

const buildPromptRequirements = (required: Readonly<string[]>): string[] =>
  Array.appendAll(required, [developmentInput.repository.href, developmentInput.task])

const prohibitedPromptPaths = ['/sandbox/', '/home/sandbox/']
const implementPromptRequirements = buildPromptRequirements([
  '/workspace/project',
  'Use the official Vite+ CLI',
  'Let vp env resolve the target project versions',
  'Use nix develop or a minimal temporary nix shell only for non-JavaScript tools',
])
const verifyPromptRequirements = ['same /workspace/project', 'official Vite+ CLI']

const inspectPrompt = (
  prompt: string,
  required: Readonly<string[]>,
): Readonly<{ forbidden: string[]; missing: string[] }> => ({
  forbidden: Array.filter(prohibitedPromptPaths, (path) => prompt.includes(path)),
  missing: Array.filter(required, (piece) => !prompt.includes(piece)),
})

type WrittenEvents = Effect.Success<Fixture['events']>
type StartHistory = Readonly<{
  eventTypes: WrittenEvents[number]['type'][]
  runEventFields: string[]
  utc: Readonly<{ created: boolean; events: boolean; updated: boolean }>
  waiting: WrittenEvents[number]
}>

const inspectStartHistory = (events: WrittenEvents, persisted: Fixture['initial']): StartHistory => ({
  eventTypes: Array.map(events, (event) => event.type),
  runEventFields: Object.keys(Array.getUnsafe(events, firstRunEvent)),
  utc: {
    created: DateTime.isUtc(persisted.createdAt),
    events: Array.every(events, (event) => DateTime.isUtc(event.createdAt)),
    updated: DateTime.isUtc(persisted.updatedAt),
  },
  waiting: Array.getUnsafe(events, waitingEvent),
})

const observeStart = Effect.fn('flowdeck.test.observeDevelopmentStart')(function* (fixture: Fixture) {
  checkIntentBeforeInitialization(fixture)
  const commitIds = yield* captureCommitIds(fixture)
  const persisted = yield* fixture.current
  const execution = yield* activeOf(persisted.snapshot)
  const { submissions } = fixture.pi.read()
  const { input } = Array.getUnsafe(submissions, firstTurn)
  return { commitIds, execution, input, persisted, submissions }
})

live('commits stable command and execution identity before external initialization and submission', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    const { commitIds, execution, input, persisted, submissions } = yield* observeStart(fixture)
    expect({ count: Array.length(commitIds), valid: Array.every(commitIds, Schema.is(CommitId)) }).toStrictEqual({
      count: 2,
      valid: true,
    })
    expect({
      commandId: execution.commandId,
      distinctExecutionId: execution.executionId !== execution.commandId,
      submissions: Array.length(submissions),
      waiting: yield* matches(persisted.snapshot, 'implement.awaiting'),
    }).toStrictEqual({ commandId: input.commandId, distinctExecutionId: true, submissions: 1, waiting: true })
    expect(inspectPrompt(input.prompt, implementPromptRequirements)).toStrictEqual({ forbidden: [], missing: [] })
    const history = inspectStartHistory(yield* fixture.events, persisted)
    expect(history).toMatchObject({
      eventTypes: ['run.started', 'node.started', 'run.waiting'],
      utc: { created: true, events: true, updated: true },
      waiting: { attempt: firstAttempt, executionId: execution.executionId, nodeId: 'implement', type: 'run.waiting' },
    })
    expect(Array.intersection(history.runEventFields, ['nodeId', 'executionId', 'attempt'])).toStrictEqual([])
  }).pipe(Effect.scoped),
)

live('polls a running operation read-only without changing checkpoints, events, initialization or submission', () =>
  Effect.gen(function* () {
    const { current, events, pi, resume, start } = yield* openDevelopmentFixture
    yield* start
    const before = yield* current
    const recorded = yield* events
    const { ensureCalls } = pi.read()
    yield* resume
    expect(yield* current).toStrictEqual(before)
    expect(yield* events).toStrictEqual(recorded)
    expect(pi.read().ensureCalls).toBe(ensureCalls)
    expect(pi.read().submissions).toHaveLength(1)
  }).pipe(Effect.scoped),
)

live('ignores repeated Start while waiting for explicit Resume', () =>
  Effect.gen(function* () {
    const { current, pi, start } = yield* openDevelopmentFixture
    yield* start
    pi.finishTurn('implement')
    const before = yield* current
    yield* start
    expect(yield* current).toStrictEqual(before)
    expect(pi.read().submissions).toHaveLength(1)
  }).pipe(Effect.scoped),
)

live('reconstructs native runtime and submits verification in the same run and root session', () =>
  Effect.gen(function* () {
    const { current, initial, pi, resume, start } = yield* openDevelopmentFixture
    yield* start
    pi.finishTurn('implement')
    yield* resume
    const { completeCalls, session, submissions } = pi.read()
    const first = Array.getUnsafe(submissions, firstTurn)
    const verification = Array.getUnsafe(submissions, verificationTurn)
    expect(yield* matches((yield* current).snapshot, 'verify.awaiting')).toBe(true)
    expect({
      completeCalls,
      distinctCommand: verification.input.commandId !== first.input.commandId,
      runId: verification.runId,
      sessionId: session.sessionId,
      submissions: Array.length(submissions),
      validCommand: Schema.is(CommandId)(verification.input.commandId),
    }).toStrictEqual({
      completeCalls: [],
      distinctCommand: true,
      runId: initial.runId,
      sessionId: '1',
      submissions: 2,
      validCommand: true,
    })
    expect(inspectPrompt(verification.input.prompt, verifyPromptRequirements)).toStrictEqual({
      forbidden: [],
      missing: [],
    })
  }).pipe(Effect.scoped),
)

type VerificationHistory = Readonly<{
  allIdsValid: boolean
  count: number
  sameExecution: boolean
  validExecutionIds: boolean
}>

const inspectVerification = (events: WrittenEvents): VerificationHistory => {
  const verification = Array.filter(events, (event) => 'nodeId' in event && event.nodeId === 'verify')
  const first = Array.getUnsafe(verification, firstVerificationEvent)
  const next = Array.getUnsafe(verification, secondVerificationEvent)
  return {
    allIdsValid: Array.every(events, (event) => Schema.is(EventId)(event.eventId)),
    count: Array.length(verification),
    sameExecution: 'executionId' in first && 'executionId' in next && first.executionId === next.executionId,
    validExecutionIds: Array.every(
      verification,
      (event) => 'executionId' in event && Schema.is(ExecutionId)(event.executionId),
    ),
  }
}

live('completes only after verification and retains container with canonical event identities', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    yield* finishVerification(fixture)
    const persisted = yield* fixture.current
    const native = yield* nativeSnapshot(persisted.snapshot)
    const completed = Option.getOrThrow(DevelopmentStates.get(native, 'completed'))
    const history = yield* fixture.events
    expect({
      calls: fixture.pi.read().completeCalls,
      output: completed.result,
      status: persisted.status,
    }).toStrictEqual({
      calls: [fixture.initial.runId],
      output: 'verify result',
      status: 'completed',
    })
    expect(inspectVerification(history)).toStrictEqual({
      allIdsValid: true,
      count: 3,
      sameExecution: true,
      validExecutionIds: true,
    })
    expect(Array.map(history, (event) => event.type)).toStrictEqual([
      'run.started',
      'node.started',
      'run.waiting',
      'run.resumed',
      'node.succeeded',
      'node.started',
      'run.waiting',
      'run.resumed',
      'node.succeeded',
      'run.completed',
    ])
    expect(yield* Effect.flip(fixture.resume)).toBeInstanceOf(InvalidOperation)
  }).pipe(Effect.scoped),
)
