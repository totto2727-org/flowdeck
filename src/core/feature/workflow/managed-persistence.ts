import { Array, DateTime, Effect, Ref } from 'effect'

import { makeCommitIdGenerator, makeEventIdGenerator } from '@/core/feature/workflow/domain/identity'
import type { RunId } from '@/core/feature/workflow/domain/identity'
import type { JsonObject, Run, RunStatus, WorkflowVersion } from '@/core/feature/workflow/domain/model'
import { LifecycleHook } from '@/core/feature/workflow/lifecycle'
import type { EventDraft } from '@/core/feature/workflow/lifecycle'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'
import type { StoreService } from '@/core/feature/workflow/services/store'

import { encodeManagedSnapshot, equivalentSnapshot } from './managed-snapshot.ts'

export type Persist<State> = (next: State, drafts: Readonly<EventDraft[]>) => Effect.Effect<void, WorkflowFailure>
type Dependencies = Readonly<{
  commitId: Effect.Success<typeof makeCommitIdGenerator>
  eventId: Effect.Success<typeof makeEventIdGenerator>
  hook: typeof LifecycleHook.Service
  store: StoreService
  version: WorkflowVersion
}>
type Writer<State> = Readonly<{
  canonical: Run
  program: Readonly<{
    encode: (state: State) => Effect.Effect<JsonObject, WorkflowFailure>
    status: (state: State) => RunStatus
  }>
  runId: RunId
}>
type Change = Readonly<{
  drafts: Readonly<EventDraft[]>
  runId: RunId
  snapshot: JsonObject
  status: RunStatus
}>

const commit = Effect.fn(function* (dependencies: Dependencies, run: Run, change: Change) {
  const { drafts, runId, snapshot, status } = change
  const updatedAt = yield* DateTime.now
  const resumed: Readonly<EventDraft[]> = run.status === 'waiting' ? [{ payload: {}, type: 'run.resumed' }] : []
  const events = yield* Effect.forEach(Array.appendAll(resumed, drafts), (draft) =>
    dependencies.eventId().pipe(Effect.map((id) => ({ ...draft, createdAt: updatedAt, eventId: id }))),
  )
  const ack = yield* dependencies.store.commit({
    commitId: yield* dependencies.commitId(),
    events,
    expectedRevision: run.revision,
    runId,
    snapshot,
    status,
    updatedAt,
  })
  return { ack, events, next: { ...run, revision: ack.revision, snapshot, status, updatedAt } }
})

export interface ManagedPersistence {
  makeWriter: <State>(writer: Writer<State>) => Effect.Effect<Persist<State>>
  store: StoreService
}

const makeManagedPersistence = (dependencies: Dependencies): ManagedPersistence => ({
  makeWriter: <State>({ canonical, program, runId }: Writer<State>): Effect.Effect<Persist<State>> =>
    Effect.gen(function* () {
      const current = yield* Ref.make(canonical)
      return Effect.fn(function* (next: State, drafts: Readonly<EventDraft[]>) {
        const run = yield* Ref.get(current)
        const machine = yield* program.encode(next)
        const snapshot = encodeManagedSnapshot({ machine, schemaVersion: 1, version: dependencies.version })
        const status = program.status(next)
        // Equal checkpoints and lifecycle notifications do not create new durable state.
        if (status === run.status && equivalentSnapshot(snapshot, run.snapshot)) {
          return
        }
        const persisted = yield* commit(dependencies, run, { drafts, runId, snapshot, status })
        yield* Ref.set(current, persisted.next)
        yield* dependencies.hook
          .afterCommit(persisted.events, persisted.ack)
          .pipe(Effect.ignoreCause({ log: 'Error', message: 'Lifecycle hook failed after managed commit' }))
      })
    }),
  store: dependencies.store,
})

export const captureManagedPersistence = Effect.fn(function* (store: StoreService, version: WorkflowVersion) {
  const hook = yield* LifecycleHook
  const commitId = yield* makeCommitIdGenerator
  const eventId = yield* makeEventIdGenerator
  return makeManagedPersistence({ commitId, eventId, hook, store, version })
})
