import { Context, Effect, Schema } from 'effect'

import type { Conflict, NotFound, ExternalError } from '../domain/errors'
import { CommitId, GraphId, RunId } from '../domain/identity'
import { type GraphDefinition, PendingRunEvent, PositiveInt, Run, type RunEvent } from '../domain/model'

export type StoreFailure = ExternalError | NotFound | Conflict
export const PendingEvent = PendingRunEvent
export type PendingEvent = typeof PendingEvent.Type
export type EventRange = { readonly _tag: 'All' } | { readonly _tag: 'ThroughRevision'; readonly revision: number }
export const CommitCommand = Schema.Struct({
  commitId: CommitId,
  runId: RunId,
  expectedRevision: Run.fields.revision,
  status: Run.fields.status,
  snapshot: Run.fields.snapshot,
  events: Schema.Array(PendingEvent),
  updatedAt: Schema.DateTimeUtc,
})
export type CommitCommand = typeof CommitCommand.Type
export const CommitAck = Schema.Struct({
  commitId: CommitId,
  runId: RunId,
  revision: Run.fields.revision,
  firstSequence: PositiveInt,
  eventCount: Run.fields.revision,
})
export type CommitAck = typeof CommitAck.Type
export interface StoreService {
  readonly create: (run: Run, graph: GraphDefinition, workflowName: string) => Effect.Effect<void, StoreFailure>
  readonly listRuns: Effect.Effect<ReadonlyArray<Run>, StoreFailure>
  readonly getRun: (runId: RunId) => Effect.Effect<Run, StoreFailure>
  readonly getGraph: (graphId: GraphId) => Effect.Effect<GraphDefinition, StoreFailure>
  readonly getEvents: (runId: RunId, range: EventRange) => Effect.Effect<ReadonlyArray<RunEvent>, StoreFailure>
  /** ACK exists only after D1 atomically commits the snapshot and complete event batch. */
  readonly commit: (command: CommitCommand) => Effect.Effect<CommitAck, StoreFailure>
}
export class Store extends Context.Service<Store, StoreService>()('flowdeck/Store') {}
