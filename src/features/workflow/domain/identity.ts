import { makePrefixedUUIDv4 } from '../../identity/id'

export const { schema: RunId, make: makeRunId } = makePrefixedUUIDv4('run')
export type RunId = typeof RunId.Type
export const { schema: ExecutionId, make: makeExecutionId } = makePrefixedUUIDv4('execution')
export type ExecutionId = typeof ExecutionId.Type
export const { schema: EventId, make: makeEventId } = makePrefixedUUIDv4('event')
export type EventId = typeof EventId.Type
export const { schema: CommitId, make: makeCommitId } = makePrefixedUUIDv4('commit')
export type CommitId = typeof CommitId.Type
