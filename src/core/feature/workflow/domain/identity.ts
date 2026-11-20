import { makePrefixedUUIDv4 } from '@/share/feature/identity/id'

export {
  UserDefinedId as WorkflowId,
  UserDefinedId as GraphId,
  UserDefinedId as NodeId,
  UserDefinedId as EdgeId,
} from '@/share/feature/identity/id'

export const { schema: RunId, make: makeRunId, makeGenerator: makeRunIdGenerator } = makePrefixedUUIDv4('run')
export type RunId = typeof RunId.Type
export const {
  schema: ExecutionId,
  make: makeExecutionId,
  makeGenerator: makeExecutionIdGenerator,
} = makePrefixedUUIDv4('execution')
export type ExecutionId = typeof ExecutionId.Type
export const { schema: EventId, make: makeEventId, makeGenerator: makeEventIdGenerator } = makePrefixedUUIDv4('event')
export type EventId = typeof EventId.Type
export const {
  schema: CommitId,
  make: makeCommitId,
  makeGenerator: makeCommitIdGenerator,
} = makePrefixedUUIDv4('commit')
export type CommitId = typeof CommitId.Type
