import { makePrefixedUUIDv4, UserDefinedId } from '../../identity/id'

export const WorkflowId = UserDefinedId
export type WorkflowId = typeof WorkflowId.Type
export const GraphId = UserDefinedId
export type GraphId = typeof GraphId.Type
export const NodeId = UserDefinedId
export type NodeId = typeof NodeId.Type
export const EdgeId = UserDefinedId
export type EdgeId = typeof EdgeId.Type

export const { schema: RunId, make: makeRunId } = makePrefixedUUIDv4('run')
export type RunId = typeof RunId.Type
export const { schema: ExecutionId, make: makeExecutionId } = makePrefixedUUIDv4('execution')
export type ExecutionId = typeof ExecutionId.Type
export const { schema: EventId, make: makeEventId } = makePrefixedUUIDv4('event')
export type EventId = typeof EventId.Type
export const { schema: CommitId, make: makeCommitId } = makePrefixedUUIDv4('commit')
export type CommitId = typeof CommitId.Type
