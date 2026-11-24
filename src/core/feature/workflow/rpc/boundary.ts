import { Cause, Crypto, Data, Effect, Match, Option, Record, Result, Schema } from 'effect'

import {
  Conflict,
  ExternalError,
  InvalidOperation,
  InvalidSnapshot,
  NotFound,
  StorageConflict,
} from '@/core/feature/workflow/domain/errors'

import { RemoteWorkerError, Rfc9457ProblemDetailsSchema, RpcProblem } from './problem.ts'
import type { Rfc9457ProblemDetails } from './problem.ts'

const RpcReply = Schema.Result(Schema.Json, Rfc9457ProblemDetailsSchema)
const wire = Schema.fromJsonString(Schema.toCodecJson(RpcReply))
const encode = Schema.encodeEffect(wire, { onExcessProperty: 'error' })
const rpcEnvelope = Schema.Result(Schema.Json, Schema.Json)
const jsonEnvelope = Schema.toCodecJson(rpcEnvelope)
const wireEnvelope = Schema.fromJsonString(jsonEnvelope)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The peer may send a non-text value or a malformed envelope.
const decodeEnvelope = Schema.decodeUnknownEffect(wireEnvelope, { onExcessProperty: 'error' })
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The peer failure can be any JSON value until its Problem Details fields are validated.
const decodeRemoteProblem = Schema.decodeUnknownEffect(Rfc9457ProblemDetailsSchema, { onExcessProperty: 'ignore' })
const decodeRemoteProblemOption = Schema.decodeUnknownOption(Rfc9457ProblemDetailsSchema, {
  onExcessProperty: 'ignore',
})
const decode = (response: unknown): Effect.Effect<typeof RpcReply.Type, Schema.SchemaError> =>
  decodeEnvelope(response).pipe(
    Effect.flatMap((reply): Effect.Effect<typeof RpcReply.Type, Schema.SchemaError> =>
      Result.isSuccess(reply)
        ? Effect.succeed(Result.succeed(reply.success))
        : decodeRemoteProblem(reply.failure).pipe(Effect.map(Result.fail)),
    ),
  )
const decodeProblem = Schema.decodeEffect(Rfc9457ProblemDetailsSchema, { onExcessProperty: 'error' })

type ProblemClassification = {
  [Problem in Rfc9457ProblemDetails as Problem['title']]: Omit<Problem, 'instance'>
}[Rfc9457ProblemDetails['title']]

const externalProblems = {
  service: RpcProblem.service,
  storage: RpcProblem.storage,
}

const classifyExternal = (error: ExternalError): ProblemClassification => {
  const problem = Record.get(externalProblems, error.kind)
  return Option.getOrElse(problem, () => RpcProblem.internal)
}

const classify = (error: unknown): ProblemClassification =>
  Match.value(error).pipe(
    Match.when(Match.instanceOf(RemoteWorkerError), (remote) => {
      const problem = decodeRemoteProblemOption(remote.cause)
      return Option.getOrElse(problem, () => RpcProblem.internal)
    }),
    Match.when(Match.instanceOf(NotFound), () => RpcProblem.notFound),
    Match.whenOr(Match.instanceOf(Conflict), Match.instanceOf(StorageConflict), () => RpcProblem.conflict),
    Match.when(Match.instanceOf(InvalidOperation), () => RpcProblem.invalidOperation),
    Match.when(Match.instanceOf(InvalidSnapshot), () => RpcProblem.invalidSnapshot),
    Match.when(Schema.isSchemaError, () => RpcProblem.invalidRequest),
    Match.when(Match.instanceOf(ExternalError), classifyExternal),
    Match.orElse(() => RpcProblem.internal),
  )

class InvalidRpcResponse extends Data.TaggedError('InvalidRpcResponse')<Readonly<{ message: string }>> {}

/** Capture the native Crypto dependency once when composing a Worker implementation. */
export const makeRpcResponse = Effect.map(
  Crypto.Crypto,
  (crypto) =>
    (operation: string) =>
    <A extends Schema.Json, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<string, never, R> =>
      effect.pipe(
        Effect.flatMap((value) => encode(Result.succeed(value)).pipe(Effect.orDie)),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt
          }
          return Effect.gen(function* () {
            const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
            const errorId: Rfc9457ProblemDetails['instance'] = `urn:uuid:${uuid}`
            const error = Option.getOrUndefined(Cause.findErrorOption(cause))
            const classification = classify(error)
            const problem = yield* decodeProblem({ ...classification, instance: errorId }).pipe(Effect.orDie)
            yield* Effect.logError('RPC operation failed', cause).pipe(
              Effect.annotateLogs({ errorId: problem.instance, operation }),
            )
            return yield* encode(Result.fail(problem)).pipe(Effect.orDie)
          })
        }),
      ),
)

/**
 * Encodes an RPC response when the composition root has not captured a responder.
 * @param {string} operation The operation name recorded on failures.
 * @returns {Function} A wrapper that encodes the effect's outcome.
 */
export const rpcResponse =
  (operation: string) =>
  <A extends Schema.Json, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<string, never, R | Crypto.Crypto> =>
    Effect.flatMap(makeRpcResponse, (respond) => respond(operation)(effect))

/**
 * Validates the wire envelope and constructs a local failure from the sanitized result.
 * @param {string} operation The local operation name.
 * @returns {Function} A decoder that accepts the peer's untrusted response.
 */
export const rpcResult =
  (operation: string) =>
  (response: unknown): Effect.Effect<Schema.Json, RemoteWorkerError | ExternalError> =>
    decode(response).pipe(
      // Never retain decoder diagnostics, which may contain secret-bearing peer bytes.
      Effect.mapError(
        () =>
          new ExternalError({
            cause: new InvalidRpcResponse({ message: 'Invalid RPC response' }),
            kind: 'service',
            operation,
          }),
      ),
      Effect.flatMap((reply) =>
        Result.isSuccess(reply)
          ? Effect.succeed(reply.success)
          : Effect.fail(new RemoteWorkerError({ cause: reply.failure, operation })),
      ),
    )
