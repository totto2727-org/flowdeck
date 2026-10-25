import { Schema } from 'effect'

import { makePrefixedUUIDv4 } from '../../identity/id'

export const { schema: RunId, make: makeRunId } = makePrefixedUUIDv4('run')
export type RunId = typeof RunId.Type
/** Existing runs used bare UUIDv4. Accept those exact identities without widening to arbitrary strings. */
export const StoredRunId = Schema.Union([RunId, Schema.String.check(Schema.isUUID(4))])
export type StoredRunId = typeof StoredRunId.Type
export const { schema: ExecutionId, make: makeExecutionId } = makePrefixedUUIDv4('execution')
export type ExecutionId = typeof ExecutionId.Type
export const { schema: EventId, make: makeEventId } = makePrefixedUUIDv4('event')
export type EventId = typeof EventId.Type
export const { schema: CommitId, make: makeCommitId } = makePrefixedUUIDv4('commit')
export type CommitId = typeof CommitId.Type
