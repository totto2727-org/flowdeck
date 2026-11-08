import { Context, Data, DateTime, Effect, Match, Ref, Schema, SemVer } from 'effect'

import { InvalidOperation, InvalidSnapshot, type DomainError } from '@/features/workflow/domain/errors'
import {
  ExecutionId,
  makeCommitIdGenerator,
  makeEventIdGenerator,
  makeExecutionIdGenerator,
  NodeId,
  type RunId,
} from '@/features/workflow/domain/identity'
import { JsonObject, PositiveInt, WorkflowVersion, type Run, type RunStatus } from '@/features/workflow/domain/model'
import type { Machine } from '@/features/workflow/machine'
import { Store, type CommitAck, type PendingEvent } from '@/features/workflow/services/store'

const base = {
  schemaVersion: Schema.Literal(1),
  version: WorkflowVersion,
  state: NodeId,
  machine: JsonObject,
  context: JsonObject,
}
const active = { ...base, executionId: ExecutionId, attempt: PositiveInt }
export const MachineSnapshot = Schema.Union([
  Schema.TaggedStruct('Ready', base),
  Schema.TaggedStruct('Running', active),
  Schema.TaggedStruct('Waiting', active),
  Schema.TaggedStruct('Completed', base),
  Schema.TaggedStruct('Failed', { ...active, message: Schema.String }),
]).pipe(Schema.toTaggedUnion('_tag'))
export type MachineSnapshot = typeof MachineSnapshot.Type
const snapshotCodec = Schema.toCodecJson(MachineSnapshot)
const decodeSnapshot = Schema.decodeUnknownEffect(snapshotCodec)
const encodeSnapshot = Schema.encodeSync(snapshotCodec)
const decodeObject = Schema.decodeUnknownSync(JsonObject)
export const encodeMachineSnapshot = (snapshot: MachineSnapshot): JsonObject => decodeObject(encodeSnapshot(snapshot))
export const statusFor = (snapshot: MachineSnapshot): RunStatus =>
  Match.value(snapshot).pipe(
    Match.tag('Ready', (): RunStatus => 'pending'),
    Match.tag('Running', (): RunStatus => 'running'),
    Match.tag('Waiting', (): RunStatus => 'waiting'),
    Match.tag('Completed', (): RunStatus => 'completed'),
    Match.tag('Failed', (): RunStatus => 'failed'),
    Match.exhaustive,
  )

type Draft<Event> = Event extends PendingEvent ? Omit<Event, 'createdAt' | 'eventId'> : never
export type EventDraft = Draft<PendingEvent>
/** Post-ACK observation is best effort. Hooks cannot undo canonical commits. */
export const LifecycleHook = Context.Reference<{
  readonly afterCommit: (events: ReadonlyArray<PendingEvent>, ack: CommitAck) => Effect.Effect<void>
}>('flowdeck/LifecycleHook', { defaultValue: () => ({ afterCommit: () => Effect.void }) })

export class TaskExecution extends Context.Service<
  TaskExecution,
  {
    readonly runId: RunId
    readonly executionId: ExecutionId
    readonly operation: 'start' | 'resume'
    readonly checkpoint: (context: unknown) => Effect.Effect<void, DomainError>
  }
>()('flowdeck/TaskExecution') {}
export type TaskResult<C> = Data.TaggedEnum<{
  Done: { readonly context: C; readonly payload: JsonObject }
  Wait: { readonly context: C }
  Fail: { readonly context: C; readonly message: string; readonly payload: JsonObject }
  Unchanged: {}
}>
export const taskResult = <C>() => Data.taggedEnum<TaskResult<C>>()
export interface Task<C> {
  readonly execute: (context: C) => Effect.Effect<TaskResult<C>, DomainError, TaskExecution>
}
export interface DefinitionOptions<C extends Record<string, unknown>, R = never> {
  readonly workflowId: string
  readonly version: WorkflowVersion
  readonly machine: Machine<JsonObject>
  readonly context: Schema.Codec<C, unknown>
  readonly tasks: Effect.Effect<Readonly<Record<string, Task<C>>>, never, R>
}
export interface Definition<C extends Record<string, unknown>, R = never> extends DefinitionOptions<C, R> {
  readonly encodeContext: (context: C) => JsonObject
  readonly decodeContext: (context: JsonObject) => Effect.Effect<C, Schema.SchemaError>
  readonly validateContext: (context: unknown) => Effect.Effect<C, Schema.SchemaError>
  readonly initialSnapshot: (context: C) => MachineSnapshot
}

/** Codecs and the pure initial plan are captured once with the definition. */
export const makeDefinition = <C extends Record<string, unknown>, R = never>(
  options: DefinitionOptions<C, R>,
): Definition<C, R> => {
  const codec = Schema.toCodecJson(options.context)
  const encode = Schema.encodeSync(codec)
  const decodeContext = Schema.decodeUnknownEffect(codec)
  const validateContext = Schema.decodeUnknownEffect(Schema.toType(options.context))
  const encodeContext = (context: C) => decodeObject(encode(context))
  const initial = Effect.runSync(options.machine.initial)
  return {
    ...options,
    encodeContext,
    decodeContext,
    validateContext,
    initialSnapshot: (context) =>
      MachineSnapshot.cases.Ready.make({
        schemaVersion: 1,
        version: options.version,
        state: initial.value,
        machine: initial.encoded,
        context: encodeContext(context),
      }),
  }
}
export const initialMachineSnapshot = <C extends Record<string, unknown>, R>(
  definition: Definition<C, R>,
  context: C,
): MachineSnapshot => definition.initialSnapshot(context)

export const restoreMachineSnapshot = <C extends Record<string, unknown>, R>(definition: Definition<C, R>, run: Run) =>
  decodeSnapshot(run.snapshot).pipe(
    Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid machine snapshot' })),
    Effect.flatMap((snapshot) =>
      Effect.gen(function* () {
        if (
          run.workflowId !== definition.workflowId ||
          !SemVer.equals(snapshot.version, definition.version) ||
          !SemVer.equals(run.workflowVersion, definition.version) ||
          run.graphId !== definition.machine.graph.graphId ||
          run.status !== statusFor(snapshot)
        )
          return yield* Effect.fail(
            new InvalidSnapshot({ message: 'Run identity, graph, version and snapshot must agree' }),
          )
        yield* definition
          .decodeContext(snapshot.context)
          .pipe(Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid workflow context' })))
        const native = yield* definition.machine.validate(snapshot.machine)
        if (native.value !== snapshot.state || native.completed !== MachineSnapshot.guards.Completed(snapshot))
          return yield* Effect.fail(new InvalidSnapshot({ message: 'Native state and task checkpoint must agree' }))
        return snapshot
      }),
    ),
  )

export const makeDriver = <C extends Record<string, unknown>, R>(definition: Definition<C, R>) =>
  Effect.gen(function* () {
    const store = yield* Store
    const tasks = yield* definition.tasks
    const hook = yield* LifecycleHook
    const commitId = yield* makeCommitIdGenerator
    const eventId = yield* makeEventIdGenerator
    const executionId = yield* makeExecutionIdGenerator
    const result = taskResult<C>()
    const save = (run: Run, snapshot: MachineSnapshot, drafts: ReadonlyArray<EventDraft>) =>
      Effect.gen(function* () {
        const updatedAt = yield* DateTime.now
        const events = yield* Effect.forEach(drafts, (event) =>
          eventId().pipe(Effect.map((id) => ({ ...event, eventId: id, createdAt: updatedAt }))),
        )
        const status = statusFor(snapshot)
        const encoded = encodeMachineSnapshot(snapshot)
        const ack = yield* store.commit({
          commitId: yield* commitId(),
          runId: run.runId,
          expectedRevision: run.revision,
          status,
          snapshot: encoded,
          events,
          updatedAt,
        })
        yield* hook
          .afterCommit(events, ack)
          .pipe(Effect.ignoreCause({ log: 'Error', message: 'Lifecycle hook failed after commit' }))
        return { ...run, status, snapshot: encoded, revision: ack.revision, updatedAt } satisfies Run
      })
    const runEvent = (type: 'run.started' | 'run.resumed' | 'run.completed' | 'run.failed'): EventDraft => ({
      type,
      payload: {},
    })
    const nodeEvent = (
      snapshot: Extract<MachineSnapshot, { _tag: 'Running' | 'Waiting' | 'Failed' }>,
      type: 'node.started' | 'node.succeeded' | 'node.failed' | 'run.waiting',
      payload: JsonObject = {},
    ): EventDraft => ({
      type,
      nodeId: snapshot.state,
      executionId: snapshot.executionId,
      attempt: snapshot.attempt,
      payload,
    })
    const execute = (
      run: Run,
      snapshot: MachineSnapshot,
      operation: 'start' | 'resume',
    ): Effect.Effect<void, DomainError> =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          if (MachineSnapshot.guards.Completed(snapshot) || MachineSnapshot.guards.Failed(snapshot))
            return yield* Effect.fail(new InvalidOperation({ message: 'Terminal runs cannot execute again' }))
          if (MachineSnapshot.guards.Waiting(snapshot) && operation === 'start') return
          const task = tasks[snapshot.state]
          if (!task) return yield* Effect.fail(new InvalidSnapshot({ message: 'Missing task for machine state' }))
          const started = MachineSnapshot.cases.Running.make({
            ...baseSnapshot(snapshot),
            executionId: MachineSnapshot.guards.Ready(snapshot) ? yield* executionId() : snapshot.executionId,
            attempt: MachineSnapshot.guards.Ready(snapshot) ? 1 : snapshot.attempt,
          })
          const current = yield* Ref.make(run)
          const currentSnapshot = yield* Ref.make(started)
          const resumePending = yield* Ref.make(MachineSnapshot.guards.Waiting(snapshot))
          const resumeEvents = Effect.gen(function* () {
            const pending = yield* Ref.get(resumePending)
            return pending ? [runEvent('run.resumed')] : []
          })
          const advance = (next: MachineSnapshot, drafts: ReadonlyArray<EventDraft>) =>
            Effect.gen(function* () {
              const latest = yield* Ref.get(current)
              const committed = yield* save(latest, next, [...(yield* resumeEvents), ...drafts])
              yield* Ref.set(resumePending, false)
              yield* Ref.set(current, committed)
              return committed
            })
          if (MachineSnapshot.guards.Ready(snapshot))
            yield* advance(started, [
              ...(run.status === 'pending' ? [runEvent('run.started')] : []),
              nodeEvent(started, 'node.started'),
            ])
          const context = yield* definition.decodeContext(snapshot.context)
          const control: typeof TaskExecution.Service = {
            runId: run.runId,
            executionId: started.executionId,
            operation: MachineSnapshot.guards.Waiting(snapshot) ? 'resume' : operation,
            checkpoint: (nextContext) =>
              Effect.gen(function* () {
                const validated = yield* definition
                  .validateContext(nextContext)
                  .pipe(Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid task checkpoint context' })))
                const next = MachineSnapshot.cases.Running.make({
                  ...activeFields(started),
                  context: definition.encodeContext(validated),
                })
                yield* advance(next, [])
                yield* Ref.set(currentSnapshot, next)
              }),
          }
          // Infrastructure errors, including checkpoint writes, propagate unchanged.
          // Only an explicit Fail outcome represents a committed business failure.
          // This invocation-scoped service closes over the current CAS revision and
          // task checkpoint Refs. An activation Layer cannot own these per-command
          // capabilities safely across concurrent runs or restored task invocations.
          // Stable Store, tasks and hooks remain acquired at driver construction.
          const outcome = yield* task.execute(context).pipe(Effect.provideService(TaskExecution, control))
          if (result.$is('Unchanged')(outcome)) return
          const activeSnapshot = yield* Ref.get(currentSnapshot)
          const nextContext = definition.encodeContext(outcome.context)
          if (result.$is('Fail')(outcome)) {
            const failed = MachineSnapshot.cases.Failed.make({
              ...activeFields(activeSnapshot),
              context: nextContext,
              message: outcome.message,
            })
            yield* advance(failed, [nodeEvent(failed, 'node.failed', outcome.payload), runEvent('run.failed')])
            return
          }
          if (result.$is('Wait')(outcome)) {
            yield* advance(
              MachineSnapshot.cases.Waiting.make({ ...activeFields(activeSnapshot), context: nextContext }),
              [nodeEvent(activeSnapshot, 'run.waiting')],
            )
            return
          }
          const next = yield* definition.machine.next(snapshot.machine, nextContext)
          if (next.completed) {
            yield* advance(
              MachineSnapshot.cases.Completed.make({
                ...baseSnapshot(activeSnapshot),
                state: next.value,
                machine: next.encoded,
                context: nextContext,
              }),
              [nodeEvent(activeSnapshot, 'node.succeeded', outcome.payload), runEvent('run.completed')],
            )
            return
          }
          const following = MachineSnapshot.cases.Running.make({
            ...baseSnapshot(activeSnapshot),
            state: next.value,
            machine: next.encoded,
            context: nextContext,
            executionId: yield* executionId(),
            attempt: 1,
          })
          const committed = yield* advance(following, [
            nodeEvent(activeSnapshot, 'node.succeeded', outcome.payload),
            nodeEvent(following, 'node.started'),
          ])
          yield* execute(committed, following, 'start')
        }),
      )
    const drive = (runId: RunId, operation: 'start' | 'resume') =>
      Effect.gen(function* () {
        const run = yield* store.getRun(runId)
        const snapshot = yield* restoreMachineSnapshot(definition, run)
        yield* execute(run, snapshot, operation)
      })
    return {
      start: (runId: RunId) => drive(runId, 'start'),
      resume: (runId: RunId) => drive(runId, 'resume'),
      restore: (run: Run) => restoreMachineSnapshot(definition, run),
    }
  })

const activeFields = (snapshot: Extract<MachineSnapshot, { _tag: 'Running' }>) => ({
  ...baseSnapshot(snapshot),
  executionId: snapshot.executionId,
  attempt: snapshot.attempt,
})

const baseSnapshot = (snapshot: MachineSnapshot) => ({
  schemaVersion: snapshot.schemaVersion,
  version: snapshot.version,
  state: snapshot.state,
  machine: snapshot.machine,
  context: snapshot.context,
})
