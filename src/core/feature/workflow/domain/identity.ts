import { makePrefixedUUIDv4 } from '@/share/feature/identity/id'

export {
  UserDefinedId as WorkflowId,
  UserDefinedId as GraphId,
  UserDefinedId as NodeId,
  UserDefinedId as EdgeId,
} from '@/share/feature/identity/id'

// oxlint-disable-next-line eslint/no-redeclare -- The owned identifier schema and its Type use the same public name.
export const { schema: RunId, make: makeRunId, makeGenerator: makeRunIdGenerator } = makePrefixedUUIDv4('run')
export type RunId = typeof RunId.Type
export const {
  // oxlint-disable-next-line eslint/no-redeclare -- The owned identifier schema and its Type use the same public name.
  schema: ExecutionId,
  make: makeExecutionId,
  makeGenerator: makeExecutionIdGenerator,
} = makePrefixedUUIDv4('execution')
export type ExecutionId = typeof ExecutionId.Type
// oxlint-disable-next-line eslint/no-redeclare -- The owned identifier schema and its Type use the same public name.
export const { schema: EventId, make: makeEventId, makeGenerator: makeEventIdGenerator } = makePrefixedUUIDv4('event')
export type EventId = typeof EventId.Type
export const {
  // oxlint-disable-next-line eslint/no-redeclare -- The owned identifier schema and its Type use the same public name.
  schema: CommitId,
  make: makeCommitId,
  makeGenerator: makeCommitIdGenerator,
} = makePrefixedUUIDv4('commit')
export type CommitId = typeof CommitId.Type
