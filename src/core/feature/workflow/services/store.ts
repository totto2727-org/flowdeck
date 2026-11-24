import type { Effect } from 'effect'
import { Context, Data, Schema } from 'effect'

import type { Conflict, NotFound, ExternalError, StorageConflict } from '@/core/feature/workflow/domain/errors'
import type { GraphId } from '@/core/feature/workflow/domain/identity'
import { CommitId, RunId } from '@/core/feature/workflow/domain/identity'
import { PendingRunEvent, PositiveInt, Run } from '@/core/feature/workflow/domain/model'
import type { GraphDefinition, RunEvent } from '@/core/feature/workflow/domain/model'

export type StoreFailure = ExternalError | NotFound | Conflict | StorageConflict
export { PendingRunEvent as PendingEvent } from '@/core/feature/workflow/domain/model'
// oxlint-disable-next-line eslint/no-redeclare -- Preserve the public case constructors and EventRange type.
export type EventRange = Data.TaggedEnum<{
  // oxlint-disable-next-line typescript/ban-types, typescript/no-empty-object-type -- Effect's All case intentionally has no payload.
  All: {}
  ThroughRevision: Readonly<{ revision: number }>
}>
export const EventRange = Data.taggedEnum<EventRange>()
// oxlint-disable-next-line eslint/no-redeclare, eslint/sort-keys -- Keep both schema and type exports and the exact serialized field order used for D1 receipt matching.
export const CommitCommand = Schema.Struct({
  commitId: CommitId,
  runId: RunId,
  expectedRevision: Run.fields.revision,
  status: Run.fields.status,
  snapshot: Run.fields.snapshot,
  events: Schema.Array(PendingRunEvent),
  updatedAt: Schema.DateTimeUtc,
})
export type CommitCommand = typeof CommitCommand.Type
// oxlint-disable-next-line eslint/no-redeclare -- Keep the acknowledgement schema and Type under the public name.
export const CommitAck = Schema.Struct({
  commitId: CommitId,
  eventCount: Run.fields.revision,
  firstSequence: PositiveInt,
  revision: Run.fields.revision,
  runId: RunId,
})
export type CommitAck = typeof CommitAck.Type
export type StoreService = Readonly<{
  create: (run: Run, graph: GraphDefinition, workflowName: string) => Effect.Effect<void, StoreFailure>
  listRuns: Effect.Effect<Readonly<Run[]>, StoreFailure>
  getRun: (runId: RunId) => Effect.Effect<Run, StoreFailure>
  getGraph: (graphId: GraphId) => Effect.Effect<GraphDefinition, StoreFailure>
  getEvents: (runId: RunId, range: EventRange) => Effect.Effect<Readonly<RunEvent[]>, StoreFailure>
  /** ACK exists only after D1 atomically commits the snapshot and complete event batch. */
  commit: (command: CommitCommand) => Effect.Effect<CommitAck, StoreFailure>
}>
export class Store extends Context.Service<Store, StoreService>()('flowdeck/Store') {}
