import { Machine } from '@typeonce/effect-machine'
import { Context, Deferred, Effect, MutableHashMap, Option, Schema, Semaphore } from 'effect'
import type { Cause, Crypto, Scope } from 'effect'

import { ExternalError, InvalidOperation } from '@/core/feature/workflow/domain/errors'
import type { GraphDefinition, JsonObject, Run, RunStatus, WorkflowVersion } from '@/core/feature/workflow/domain/model'
import type { EventDraft } from '@/core/feature/workflow/lifecycle'
import { ResourceStore } from '@/core/feature/workflow/resource-store'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'
import { Store } from '@/core/feature/workflow/services/store'

import { captureManagedPersistence } from './managed-persistence.ts'
import type { ManagedPersistence, Persist } from './managed-persistence.ts'
import { restoreManagedSnapshot } from './managed-snapshot.ts'
import type { ManagedRestoration } from './managed-snapshot.ts'

export type { EventDraft } from '@/core/feature/workflow/lifecycle'
export { ManagedSnapshot, encodeManagedSnapshot, restoreManagedSnapshot } from './managed-snapshot.ts'
export type { ManagedRestoration } from './managed-snapshot.ts'

// oxlint-disable-next-line eslint/no-redeclare -- The native machine protocol uses ResumeEvent as both the schema and the event type.
export const ResumeEvent = Schema.TaggedStruct('Resume', {})
export type ResumeEvent = typeof ResumeEvent.Type
export const resumeEvent: ResumeEvent = ResumeEvent.make({})

/** Command-local persistence capability. Storage errors fail the host, not a business invoke outcome. */
export class WorkflowCheckpoint extends Context.Service<
  WorkflowCheckpoint,
  Readonly<{
    runId: RunId
    checkpoint: (drafts: Readonly<EventDraft[]>) => Effect.Effect<void>
    fail: (error: WorkflowFailure) => Effect.Effect<never>
  }>
>()('flowdeck/WorkflowCheckpoint') {}

/** Stable dependencies are acquired by Definition.program once, before any command Scope. */
export type ManagedProgram<State, NativeError, Output> = Readonly<{
  decode: (encoded: JsonObject) => Effect.Effect<State, WorkflowFailure>
  encode: (state: State) => Effect.Effect<JsonObject, WorkflowFailure>
  /** Fresh pending runs use native start with pure input derived from their initial state. */
  start: (
    state: State,
  ) => Effect.Effect<
    Machine.MachineRef<State, ResumeEvent, NativeError, Output>,
    NativeError,
    WorkflowCheckpoint | ResourceStore | Scope.Scope
  >
  /** Existing checkpoints use native resume, never a custom restoration interpreter. */
  resume: (
    state: State,
  ) => Effect.Effect<
    Machine.MachineRef<State, ResumeEvent, NativeError, Output>,
    NativeError,
    WorkflowCheckpoint | ResourceStore | Scope.Scope
  >
  isReplyBoundary: (state: State) => boolean
  status: (state: State) => RunStatus
  boundaryEvents: (state: State) => Readonly<EventDraft[]>
  mapError: (error: NativeError | Machine.StoppedError | Cause.NoSuchElementError) => WorkflowFailure
}>

export type ManagedDefinition<State, NativeError, Output, Requirements = never> = Readonly<{
  workflowId: string
  version: WorkflowVersion
  graph: GraphDefinition
  program: Effect.Effect<ManagedProgram<State, NativeError, Output>, never, Requirements>
}>

type RunId = Run['runId']
type Operation = 'start' | 'resume'
type Checkpoint = (drafts: Readonly<EventDraft[]>) => Effect.Effect<void, WorkflowFailure>
type ManagedExecutor<State> = Readonly<{
  restore: (run: Run) => Effect.Effect<State, WorkflowFailure>
  resume: (runId: RunId) => Effect.Effect<undefined, WorkflowFailure>
  start: (runId: RunId) => Effect.Effect<undefined, WorkflowFailure>
}>
type Command<State> = Readonly<{
  canonical: Run
  operation: Operation
  persist: Persist<State>
  runId: RunId
  state: State
}>

const makeCheckpoint = (
  runId: RunId,
  storageFailure: Deferred.Deferred<never, WorkflowFailure>,
  refReady: Deferred.Deferred<Checkpoint>,
): WorkflowCheckpoint['Service'] => {
  // Let the native sender register ownership before aborting the host's scope.
  const fail = (error: WorkflowFailure): Effect.Effect<never> =>
    Effect.yieldNow.pipe(
      Effect.andThen(Deferred.fail(storageFailure, error)),
      Effect.andThen(Effect.never),
      Effect.interruptible,
    )
  return {
    checkpoint: (drafts) =>
      Deferred.await(refReady).pipe(
        Effect.flatMap((saveCurrent) => saveCurrent(drafts)),
        Effect.matchEffect({ onFailure: fail, onSuccess: () => Effect.void }),
      ),
    fail,
    runId,
  }
}

const commandLatches = Effect.gen(function* () {
  const refReady = yield* Deferred.make<Checkpoint>()
  const storageFailure = yield* Deferred.make<never, WorkflowFailure>()
  return { refReady, storageFailure }
})

const runCommand = <State, NativeError, Output>(
  program: ManagedProgram<State, NativeError, Output>,
  command: Command<State>,
): Effect.Effect<undefined, WorkflowFailure, ResourceStore | Scope.Scope> =>
  Effect.gen(function* () {
    const { canonical, operation, persist, runId, state } = command
    const { refReady, storageFailure } = yield* commandLatches
    const opening = canonical.status === 'pending' ? program.start(state) : program.resume(state)
    const ref = yield* opening.pipe(
      Effect.provideService(WorkflowCheckpoint, makeCheckpoint(runId, storageFailure, refReady)),
      Effect.mapError(program.mapError),
    )
    yield* Deferred.succeed(refReady, (drafts) => ref.state.pipe(Effect.flatMap((next) => persist(next, drafts))))
    if (operation === 'resume') {
      yield* ref.send(resumeEvent).pipe(Effect.mapError(program.mapError))
    }
    const boundary = yield* Machine.waitFor(ref, (snapshot) => program.isReplyBoundary(snapshot.state)).pipe(
      Effect.mapError(program.mapError),
      Effect.raceFirst(Deferred.await(storageFailure)),
    )
    yield* persist(boundary.state, program.boundaryEvents(boundary.state))
    return yield* Effect.undefined
  })

const executor = <State, NativeError, Output>(
  program: ManagedProgram<State, NativeError, Output>,
  restore: ManagedExecutor<State>['restore'],
  persist: ManagedPersistence,
): ManagedExecutor<State> => {
  const locks = MutableHashMap.empty<RunId, Semaphore.Semaphore>()
  const exclusivePermit = 1
  const execute = (runId: RunId, operation: Operation): Effect.Effect<undefined, WorkflowFailure> =>
    Effect.scoped(
      Effect.gen(function* () {
        const canonical = yield* persist.store.getRun(runId)
        const state = yield* restore(canonical)
        if (canonical.status === 'completed' || canonical.status === 'failed') {
          return yield* Effect.fail(new InvalidOperation({ message: 'Terminal runs cannot execute again' }))
        }
        const write = yield* persist.makeWriter({ canonical, program, runId })
        return yield* runCommand(program, { canonical, operation, persist: write, runId, state })
      }),
    ).pipe(
      // Lazy native invokes share one volatile resource scope until boundary ACK and teardown.
      Effect.provide(ResourceStore.layer),
      Effect.catchDefect((cause) =>
        Effect.fail(new ExternalError({ cause, kind: 'service', operation: 'execute native machine' })),
      ),
    )
  const command = (runId: RunId, operation: Operation): Effect.Effect<undefined, WorkflowFailure> =>
    Effect.suspend(() => {
      const lock = Option.getOrElse(MutableHashMap.get(locks, runId), () => {
        const created = Semaphore.makeUnsafe(exclusivePermit)
        MutableHashMap.set(locks, runId, created)
        return created
      })
      const running = execute(runId, operation)
      return lock.withPermit(running).pipe(Effect.tapCause(Effect.logError))
    })
  return {
    restore: (run) => restore(run).pipe(Effect.tapCause(Effect.logError)),
    resume: (runId) => command(runId, 'resume'),
    start: (runId) => command(runId, 'start'),
  }
}

// Capture stable dependencies once. Each command owns its own persistence and resource scope.
export const makeManagedExecutor = <State, NativeError, Output, Requirements>(
  definition: ManagedDefinition<State, NativeError, Output, Requirements>,
): Effect.Effect<ManagedExecutor<State>, never, Crypto.Crypto | Store | Requirements> =>
  Effect.gen(function* () {
    const store = yield* Store
    const program = yield* definition.program
    const { graph, version, workflowId } = definition
    const persistence = yield* captureManagedPersistence(store, version)
    const restoration: ManagedRestoration<State> = {
      decode: program.decode,
      graph,
      status: program.status,
      version,
      workflowId,
    }
    return executor(program, (run) => restoreManagedSnapshot(restoration, run), persistence)
  })
