import { Machine } from '@typeonce/effect-machine'
import {
  Array,
  type Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  MutableHashMap,
  Option,
  Ref,
  Schema,
  type Scope,
  Semaphore,
  SemVer,
} from 'effect'

import { ExternalError, InvalidOperation, InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { makeCommitIdGenerator, makeEventIdGenerator, type RunId } from '@/core/feature/workflow/domain/identity'
import {
  JsonObject,
  type GraphDefinition,
  type Run,
  type RunStatus,
  WorkflowVersion,
} from '@/core/feature/workflow/domain/model'
import { type EventDraft, LifecycleHook } from '@/core/feature/workflow/lifecycle'
import { ResourceStore } from '@/core/feature/workflow/resource-store'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'
import { Store } from '@/core/feature/workflow/services/store'

export type { EventDraft } from '@/core/feature/workflow/lifecycle'

export const ResumeEvent = Schema.TaggedStruct('Resume', {})
export type ResumeEvent = typeof ResumeEvent.Type
export const resumeEvent: ResumeEvent = ResumeEvent.make({})

/** Command-local persistence capability. Storage errors fail the host, not a business invoke outcome. */
export class WorkflowCheckpoint extends Context.Service<
  WorkflowCheckpoint,
  {
    readonly runId: RunId
    readonly checkpoint: (drafts: ReadonlyArray<EventDraft>) => Effect.Effect<void>
    readonly fail: (error: WorkflowFailure) => Effect.Effect<never>
  }
>()('flowdeck/WorkflowCheckpoint') {}

export const ManagedSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: WorkflowVersion,
  machine: JsonObject,
})
export type ManagedSnapshot = typeof ManagedSnapshot.Type
const snapshotCodec = Schema.toCodecJson(ManagedSnapshot)
const decodeSnapshot = Schema.decodeUnknownEffect(snapshotCodec)
const encodeSnapshot = Schema.encodeSync(snapshotCodec)
const decodeObject = Schema.decodeUnknownSync(JsonObject)
const equivalentSnapshot = Schema.toEquivalence(JsonObject)

export const encodeManagedSnapshot = (snapshot: ManagedSnapshot): JsonObject => decodeObject(encodeSnapshot(snapshot))

/** Stable dependencies are acquired by Definition.program once, before any command Scope. */
export interface ManagedProgram<State, NativeError, Output> {
  readonly decode: (encoded: JsonObject) => Effect.Effect<State, WorkflowFailure>
  readonly encode: (state: State) => Effect.Effect<JsonObject, WorkflowFailure>
  /** Fresh pending runs use native start with pure input derived from their initial state. */
  readonly start: (
    state: State,
  ) => Effect.Effect<
    Machine.MachineRef<State, ResumeEvent, NativeError, Output>,
    NativeError,
    WorkflowCheckpoint | ResourceStore | Scope.Scope
  >
  /** Existing checkpoints use native resume, never a custom restoration interpreter. */
  readonly resume: (
    state: State,
  ) => Effect.Effect<
    Machine.MachineRef<State, ResumeEvent, NativeError, Output>,
    NativeError,
    WorkflowCheckpoint | ResourceStore | Scope.Scope
  >
  readonly isReplyBoundary: (state: State) => boolean
  readonly status: (state: State) => RunStatus
  readonly boundaryEvents: (state: State) => ReadonlyArray<EventDraft>
  readonly mapError: (error: NativeError | Machine.StoppedError | Cause.NoSuchElementError) => WorkflowFailure
}

export interface ManagedDefinition<State, NativeError, Output, Requirements = never> {
  readonly workflowId: string
  readonly version: WorkflowVersion
  readonly graph: GraphDefinition
  readonly program: Effect.Effect<ManagedProgram<State, NativeError, Output>, never, Requirements>
}

/** Codec validation requires no Store, provider runtime, or Crypto dependencies. */
export interface ManagedRestoration<State> {
  readonly workflowId: string
  readonly version: WorkflowVersion
  readonly graph: GraphDefinition
  readonly decode: (encoded: JsonObject) => Effect.Effect<State, WorkflowFailure>
  readonly status: (state: State) => RunStatus
}

export const restoreManagedSnapshot = <State>(definition: ManagedRestoration<State>, run: Run) =>
  Effect.gen(function* () {
    const snapshot = yield* decodeSnapshot(run.snapshot).pipe(
      Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid managed machine snapshot' })),
    )
    if (
      run.workflowId !== definition.workflowId ||
      !SemVer.equals(run.workflowVersion, definition.version) ||
      !SemVer.equals(snapshot.version, definition.version) ||
      run.graphId !== definition.graph.graphId
    )
      return yield* Effect.fail(new InvalidSnapshot({ message: 'Run identity, version and graph must agree' }))
    const state = yield* definition.decode(snapshot.machine)
    if (definition.status(state) !== run.status)
      return yield* Effect.fail(new InvalidSnapshot({ message: 'Native state and run status must agree' }))
    return state
  }).pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(
        new ExternalError({
          kind: 'service',
          operation: 'restore native machine',
          cause,
        }),
      ),
    ),
  )

/** Request-scoped native execution, with D1 as the only canonical execution state. */
export const makeManagedExecutor = <State, NativeError, Output, Requirements>(
  definition: ManagedDefinition<State, NativeError, Output, Requirements>,
) =>
  Effect.gen(function* () {
    const store = yield* Store
    const program = yield* definition.program
    const hook = yield* LifecycleHook
    const commitId = yield* makeCommitIdGenerator
    const eventId = yield* makeEventIdGenerator
    const locks = MutableHashMap.empty<RunId, Semaphore.Semaphore>()

    const restoration: ManagedRestoration<State> = {
      workflowId: definition.workflowId,
      version: definition.version,
      graph: definition.graph,
      decode: program.decode,
      status: program.status,
    }
    const restore = (run: Run) => restoreManagedSnapshot(restoration, run)

    const execute = (runId: RunId, operation: 'start' | 'resume') =>
      Effect.scoped(
        Effect.gen(function* () {
          const canonical = yield* store.getRun(runId)
          const state = yield* restore(canonical)
          if (canonical.status === 'completed' || canonical.status === 'failed')
            return yield* Effect.fail(new InvalidOperation({ message: 'Terminal runs cannot execute again' }))
          const current = yield* Ref.make(canonical)
          const storageFailure = yield* Deferred.make<never, WorkflowFailure>()
          type Checkpoint = (drafts: ReadonlyArray<EventDraft>) => Effect.Effect<void, WorkflowFailure>
          const refReady = yield* Deferred.make<Checkpoint>()

          const persist = (next: State, drafts: ReadonlyArray<EventDraft>) =>
            Effect.gen(function* () {
              const run = yield* Ref.get(current)
              const encoded = encodeManagedSnapshot({
                schemaVersion: 1,
                version: definition.version,
                machine: yield* program.encode(next),
              })
              const status = program.status(next)
              // Native lifecycle notifications and unchanged polls are not new durable state.
              if (status === run.status && equivalentSnapshot(encoded, run.snapshot)) return
              const updatedAt = yield* DateTime.now
              const resumed: ReadonlyArray<EventDraft> =
                run.status === 'waiting' ? [{ type: 'run.resumed', payload: {} }] : []
              const events = yield* Effect.forEach(Array.appendAll(resumed, drafts), (draft) =>
                eventId().pipe(Effect.map((id) => ({ ...draft, eventId: id, createdAt: updatedAt }))),
              )
              const ack = yield* store.commit({
                commitId: yield* commitId(),
                runId,
                expectedRevision: run.revision,
                status,
                snapshot: encoded,
                events,
                updatedAt,
              })
              yield* Ref.set(current, { ...run, status, snapshot: encoded, revision: ack.revision, updatedAt })
              yield* hook
                .afterCommit(events, ack)
                .pipe(Effect.ignoreCause({ log: 'Error', message: 'Lifecycle hook failed after managed commit' }))
            })

          // An invoke starts in the native sender's turn. Yield before failing
          // the host so native child ownership is registered before Scope teardown.
          // The host cancels this suspended invoke, never a business onFailure path.
          const fail = (error: WorkflowFailure): Effect.Effect<never> =>
            Effect.yieldNow.pipe(
              Effect.andThen(Deferred.fail(storageFailure, error)),
              Effect.andThen(Effect.never),
              Effect.interruptible,
            )
          const checkpoint: typeof WorkflowCheckpoint.Service = {
            runId,
            fail,
            checkpoint: (drafts) =>
              Deferred.await(refReady).pipe(
                Effect.flatMap((saveCurrent) => saveCurrent(drafts)),
                Effect.catch(fail),
              ),
          }
          // This service closes over this command's ref-ready latch and CAS revision.
          // A stable runtime Layer cannot supply per-command capabilities. All ordinary
          // program dependencies were already captured above, once at construction.
          const opening = canonical.status === 'pending' ? program.start(state) : program.resume(state)
          const ref = yield* opening.pipe(
            Effect.provideService(WorkflowCheckpoint, checkpoint),
            Effect.mapError(program.mapError),
          )
          yield* Deferred.succeed(refReady, (drafts) => ref.state.pipe(Effect.flatMap((next) => persist(next, drafts))))
          if (operation === 'resume') yield* ref.send(resumeEvent).pipe(Effect.mapError(program.mapError))
          const boundary = yield* Machine.waitFor(ref, (snapshot) => program.isReplyBoundary(snapshot.state)).pipe(
            Effect.mapError(program.mapError),
            Effect.raceFirst(Deferred.await(storageFailure)),
          )
          yield* persist(boundary.state, program.boundaryEvents(boundary.state))
        }),
      ).pipe(
        // One volatile resource scope covers the entire command, not just the
        // native start/resume call. Lazy invokes share it until boundary ACK and
        // native Scope closure. A new command receives a fresh resource scope.
        Effect.provide(ResourceStore.layer),
        Effect.catchDefect((cause) =>
          Effect.fail(
            new ExternalError({
              kind: 'service',
              operation: 'execute native machine',
              cause,
            }),
          ),
        ),
      )

    const command = (runId: RunId, operation: 'start' | 'resume') =>
      Effect.suspend(() => {
        const lock = Option.getOrElse(MutableHashMap.get(locks, runId), () => {
          const created = Semaphore.makeUnsafe(1)
          MutableHashMap.set(locks, runId, created)
          return created
        })
        return execute(runId, operation).pipe(lock.withPermits(1), Effect.tapCause(Effect.logError))
      })

    return {
      start: (runId: RunId) => command(runId, 'start'),
      resume: (runId: RunId) => command(runId, 'resume'),
      restore: (run: Run) => restore(run).pipe(Effect.tapCause(Effect.logError)),
    }
  })
