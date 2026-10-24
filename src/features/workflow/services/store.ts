import { Context, Effect } from 'effect'

import type { Conflict, NotFound, ExternalError } from '../domain/errors'
import type { GraphDefinition, Run, RunEvent, RunStatus } from '../domain/model'

export type StoreFailure = ExternalError | NotFound | Conflict
export type PendingEvent = Omit<RunEvent, 'sequence' | 'runId'>
export type EventRange = { readonly _tag: 'All' } | { readonly _tag: 'ThroughRevision'; readonly revision: number }
export interface CommitCommand {
  readonly commitId: string
  readonly runId: string
  readonly expectedRevision: number
  readonly status: RunStatus
  readonly snapshot: unknown
  readonly events: ReadonlyArray<PendingEvent>
  readonly updatedAt: string
}
export interface CommitAck {
  readonly commitId: string
  readonly runId: string
  readonly revision: number
  readonly firstSequence: number
  readonly eventCount: number
}
export interface StoreService {
  readonly create: (run: Run, graph: GraphDefinition, workflowName: string) => Effect.Effect<void, StoreFailure>
  readonly listRuns: Effect.Effect<ReadonlyArray<Run>, StoreFailure>
  readonly getRun: (runId: string) => Effect.Effect<Run, StoreFailure>
  readonly getGraph: (graphId: string) => Effect.Effect<GraphDefinition, StoreFailure>
  readonly getEvents: (runId: string, range: EventRange) => Effect.Effect<ReadonlyArray<RunEvent>, StoreFailure>
  /** ACK exists only after D1 atomically commits the snapshot and complete event batch. */
  readonly commit: (command: CommitCommand) => Effect.Effect<CommitAck, StoreFailure>
}
export class Store extends Context.Service<Store, StoreService>()('flowdeck/Store') {}
