import { Context, Effect } from 'effect'

import type { Conflict, NotFound, StoreError } from '../domain/errors'
import type { GraphDefinition, Run, RunEvent, RunStatus } from '../domain/model'

export type StoreFailure = StoreError | NotFound | Conflict
export type PendingEvent = Omit<RunEvent, 'sequence' | 'runId'>
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
  readonly create: (run: Run, graph: GraphDefinition) => Effect.Effect<void, StoreFailure>
  readonly listRuns: Effect.Effect<ReadonlyArray<Run>, StoreFailure>
  readonly getRun: (runId: string) => Effect.Effect<Run, StoreFailure>
  readonly getGraph: (graphId: string) => Effect.Effect<GraphDefinition, StoreFailure>
  readonly getEvents: (runId: string, throughRevision?: number) => Effect.Effect<ReadonlyArray<RunEvent>, StoreFailure>
  /** ACK exists only after D1 atomically commits the snapshot and complete event batch. */
  readonly commit: (command: CommitCommand) => Effect.Effect<CommitAck, StoreFailure>
}
export class Store extends Context.Service<Store, StoreService>()('flowdeck/Store') {}
