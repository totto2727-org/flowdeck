import { Data, Schema } from 'effect'

const instance = Schema.TemplateLiteral(['urn:uuid:', Schema.String.check(Schema.isUUID(4))])
const problem = <const T extends string, const S extends number, const D extends string>(
  type: T,
  status: S,
  detail: D,
) =>
  Schema.Struct({
    type: Schema.Literal(`https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#${type}`),
    title: Schema.Literal(type),
    status: Schema.Literal(status),
    detail: Schema.Literal(detail),
    instance,
  })

/** RFC 9457 types are documented by their absolute URLs. Unknown extensions are discarded. */
export const RpcProblem = Schema.Union([
  problem('not-found', 404, 'The requested resource was not found.'),
  problem('conflict', 409, 'The operation conflicts with the current state.'),
  problem('invalid-operation', 409, 'The operation is not allowed in the current state.'),
  problem('invalid-snapshot', 409, 'The workflow state cannot be used for this operation.'),
  problem('storage', 500, 'A persistence operation failed.'),
  problem('service', 502, 'A required service could not complete the operation.'),
  problem('invalid-request', 400, 'The request did not match the expected schema.'),
  problem('internal', 500, 'The operation could not be completed.'),
])
export type RpcProblem = typeof RpcProblem.Type

/** A new local error, never a revived remote exception or remote stack. */
export class RemoteWorkerError extends Data.TaggedError('RemoteWorkerError')<{
  readonly operation: string
  readonly cause: RpcProblem
}> {}
