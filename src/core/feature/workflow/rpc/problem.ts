import { Data, Schema } from 'effect'

const uuidVersion = 4
const instance = Schema.TemplateLiteral(['urn:uuid:', Schema.String.check(Schema.isUUID(uuidVersion))])
const problemDocumentation = 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md'
type ProblemUri<Title extends string> = `${typeof problemDocumentation}#${Title}`
type ProblemFields<Title extends string, Status extends number, Detail extends string> = Readonly<{
  detail: Detail
  status: Status
  title: Title
}>
type DefinedProblem<Title extends string, Status extends number, Detail extends string> = ProblemFields<
  Title,
  Status,
  Detail
> &
  Readonly<{ type: ProblemUri<Title> }>

const problemUri = <const Title extends string>(title: Title): ProblemUri<Title> => `${problemDocumentation}#${title}`
const defineProblem = <const Title extends string, const Status extends number, const Detail extends string>(
  fields: ProblemFields<Title, Status, Detail>,
): DefinedProblem<Title, Status, Detail> => Object.freeze({ ...fields, type: problemUri(fields.title) })

export const RpcProblem = Object.freeze({
  conflict: defineProblem({
    detail: 'The operation conflicts with the current state.',
    status: 409,
    title: 'conflict',
  }),
  internal: defineProblem({
    detail: 'The operation could not be completed.',
    status: 500,
    title: 'internal',
  }),
  invalidOperation: defineProblem({
    detail: 'The operation is not allowed in the current state.',
    status: 409,
    title: 'invalid-operation',
  }),
  invalidRequest: defineProblem({
    detail: 'The request did not match the expected schema.',
    status: 400,
    title: 'invalid-request',
  }),
  invalidSnapshot: defineProblem({
    detail: 'The workflow state cannot be used for this operation.',
    status: 409,
    title: 'invalid-snapshot',
  }),
  notFound: defineProblem({
    detail: 'The requested resource was not found.',
    status: 404,
    title: 'not-found',
  }),
  service: defineProblem({
    detail: 'A required service could not complete the operation.',
    status: 502,
    title: 'service',
  }),
  storage: defineProblem({
    detail: 'A persistence operation failed.',
    status: 500,
    title: 'storage',
  }),
})

type ProblemSchema<Title extends string, Status extends number, Detail extends string> = Schema.Struct<{
  type: Schema.Literal<ProblemUri<Title>>
  title: Schema.Literal<Title>
  status: Schema.Literal<Status>
  detail: Schema.Literal<Detail>
  instance: typeof instance
}>

const problem = <const Title extends string, const Status extends number, const Detail extends string>(
  fields: DefinedProblem<Title, Status, Detail>,
): ProblemSchema<Title, Status, Detail> =>
  // Retain the published RPC Problem Details serialization order.
  Schema.Struct({
    type: Schema.Literal(fields.type),
    title: Schema.Literal(fields.title),
    status: Schema.Literal(fields.status),
    detail: Schema.Literal(fields.detail),
    instance,
  })

/**
 * Application profile of RFC 9457 Problem Details: https://www.rfc-editor.org/rfc/rfc9457.html#section-3
 * This profile fixes the public problem types and messages and uses UUIDv4 occurrence URIs.
 * RPC carries these JSON details as its failure value, not as an HTTP response body.
 */
export const Rfc9457ProblemDetailsSchema = Schema.Union([
  problem(RpcProblem.notFound),
  problem(RpcProblem.conflict),
  problem(RpcProblem.invalidOperation),
  problem(RpcProblem.invalidSnapshot),
  problem(RpcProblem.storage),
  problem(RpcProblem.service),
  problem(RpcProblem.invalidRequest),
  problem(RpcProblem.internal),
])
export type Rfc9457ProblemDetails = typeof Rfc9457ProblemDetailsSchema.Type

/** A new local error, never a revived remote exception or remote stack. */
export class RemoteWorkerError extends Data.TaggedError('RemoteWorkerError')<
  Readonly<{
    operation: string
    cause: Rfc9457ProblemDetails
  }>
> {}
