import { Machine } from '@typeonce/effect-machine'
import { Effect, Schema } from 'effect'

import { ExternalError, InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import type { RunStatus } from '@/core/feature/workflow/domain/model'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'

import type { makeManagedObservers } from './managed-runtime-observers.fixture.ts'
import { workflowId } from './managed-runtime-persistence.fixture.ts'
import { ResumeEvent } from './managed-runtime.ts'
import type { EventDraft } from './managed-runtime.ts'

type ObserverFixture = Effect.Success<ReturnType<typeof makeManagedObservers>>

const executionId = 'execution_00000000-0000-4000-8000-000000000001'
const firstAttempt = 1
const rejectedPhase = 0
const acceptedPhase = 1
const positivePhase = Schema.Int.check(Schema.isGreaterThan(rejectedPhase))
const states = Machine.state({
  states: {
    A: {},
    ASecond: Schema.TaggedStruct('ASecond', { phase: positivePhase }),
    Another: {},
    B: {},
    Check: {},
    Failed: { type: 'final' },
    Final: { type: 'final' },
    Pending: {},
    Waiting: {},
  },
})
const events = Machine.eventsFromSchemas(ResumeEvent)

const node = (nodeId: string): Readonly<{ attempt: number; executionId: string; nodeId: string }> => ({
  attempt: firstAttempt,
  executionId,
  nodeId,
})

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The native machine encoder returns an unchecked wire value.
const decodeJson = Schema.decodeUnknownEffect(Schema.JsonObject)

const nativeDefinition = Effect.fn('flowdeck.test.defineNativeMachine')(function* ({
  check,
  effect,
  readControls,
}: ObserverFixture) {
  const native = yield* Effect.sync(() =>
    Machine.make({
      branches: {
        checked: { finish: { target: 'B' }, wait: { target: 'Waiting' } },
        nextA: { again: { target: 'ASecond' }, failed: { target: 'Failed' }, wait: { target: 'Waiting' } },
      },
      effects: {
        a: effect('A', [
          { payload: {}, type: 'run.started' },
          { ...node('A'), payload: {}, type: 'node.started' },
        ]),
        another: Effect.sync(readControls),
        b: effect('B', [{ ...node('B'), payload: {}, type: 'node.started' }]),
        check,
        prepare: Effect.void,
        secondA: effect('A phase 2', []),
      },
      events,
      id: workflowId,
      root: states,
    }),
  )
  return native
})

const nativeMachine = Effect.fn('flowdeck.test.connectNativeMachine')(function* (fixture: ObserverFixture) {
  const native = yield* nativeDefinition(fixture)
  return native.handle({
    initial: { target: 'Pending' },
    states: {
      A: { invoke: { onDone: { target: 'Another' }, src: 'a' } },
      ASecond: { invoke: { onDone: { target: 'Waiting' }, src: 'secondA' } },
      Another: {
        invoke: {
          onDone: {
            branches: 'nextA',
            resolve: ({ output, select }) => {
              if (output.businessFailure) {
                return select.failed()
              }
              if (output.multipleCheckpoints) {
                const phase = output.invalidPhase ? rejectedPhase : acceptedPhase
                return select.again({ data: { phase } })
              }
              return select.wait()
            },
          },
          src: 'another',
        },
      },
      B: { invoke: { onDone: { target: 'Final' }, src: 'b' } },
      Check: {
        invoke: {
          onDone: { branches: 'checked', resolve: ({ output, select }) => (output ? select.finish() : select.wait()) },
          src: 'check',
        },
      },
      Failed: {},
      Final: {},
      Pending: { invoke: { onDone: { target: 'A' }, src: 'prepare' } },
      Waiting: { on: { Resume: { target: 'Check' } } },
    },
  })
})

type NativeMachine = Effect.Success<ReturnType<typeof nativeMachine>>
type State = Machine.Machine.Snapshot<Machine.Machine.States<NativeMachine>>

const status = (state: State): RunStatus => {
  if (states.matches(state, 'Pending')) {
    return 'pending'
  }
  if (states.matches(state, 'Waiting')) {
    return 'waiting'
  }
  if (states.matches(state, 'Final')) {
    return 'completed'
  }
  return states.matches(state, 'Failed') ? 'failed' : 'running'
}

const boundaryEvents = (state: State): Readonly<EventDraft[]> => {
  if (states.matches(state, 'Failed')) {
    return [
      { ...node('A'), payload: { reason: 'invalid' }, type: 'node.failed' },
      { payload: {}, type: 'run.failed' },
    ]
  }
  if (states.matches(state, 'Waiting')) {
    return [
      { ...node('A'), payload: {}, type: 'node.succeeded' },
      { ...node('A'), payload: {}, type: 'run.waiting' },
    ]
  }
  return [
    { ...node('B'), payload: {}, type: 'node.succeeded' },
    { payload: {}, type: 'run.completed' },
  ]
}

const mapError = (error: unknown): WorkflowFailure =>
  error instanceof ExternalError ? error : new InvalidSnapshot({ message: 'Native test execution failed' })

export const prepareManagedProgram = Effect.fn('flowdeck.test.prepareManagedRuntime')(function* (
  fixture: ObserverFixture,
) {
  const native = yield* nativeMachine(fixture)
  const program = {
    boundaryEvents,
    decode: (encoded: Schema.JsonObject['Type']) =>
      Machine.decodeSnapshot(native, encoded).pipe(
        Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid native test state' })),
      ),
    encode: (state: State) =>
      Machine.encodeSnapshot(native, state).pipe(
        Effect.flatMap(decodeJson),
        Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid native test encoding' })),
      ),
    isReplyBoundary: (state: State) =>
      states.matches(state, 'Waiting') || states.matches(state, 'Final') || states.matches(state, 'Failed'),
    mapError,
    resume: (state: State) =>
      Effect.sync(() => {
        fixture.resumed()
      }).pipe(Effect.andThen(Machine.resume(native, state))),
    start: () =>
      Effect.sync(() => {
        fixture.started()
      }).pipe(Effect.andThen(Machine.start(native))),
    status,
  }
  const initial = yield* Machine.planInitial(native)
  const machine = yield* program.encode(initial.state)
  return { machine, program }
})
