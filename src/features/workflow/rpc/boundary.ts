import { Cause, Crypto, Effect, Option, Result, Schema } from 'effect'

import {
  Conflict,
  ExternalError,
  InvalidOperation,
  InvalidSnapshot,
  NotFound,
  StorageConflict,
} from '@/features/workflow/domain/errors'

import { RemoteWorkerError, Rfc9457ProblemDetails } from './problem'

const RpcReply = Schema.Result(Schema.Json, Rfc9457ProblemDetails)
const wire = Schema.fromJsonString(Schema.toCodecJson(RpcReply))
const encode = Schema.encodeEffect(wire, { onExcessProperty: 'error' })
const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Schema.Result(Schema.Json, Schema.Json))),
  { onExcessProperty: 'error' },
)
const decodeRemoteProblem = Schema.decodeUnknownEffect(Rfc9457ProblemDetails, { onExcessProperty: 'ignore' })
const decodeRemoteProblemOption = Schema.decodeUnknownOption(Rfc9457ProblemDetails, { onExcessProperty: 'ignore' })
const decode = (response: unknown) =>
  decodeEnvelope(response).pipe(
    Effect.flatMap((reply): Effect.Effect<typeof RpcReply.Type, Schema.SchemaError> =>
      Result.isSuccess(reply)
        ? Effect.succeed(Result.succeed(reply.success))
        : decodeRemoteProblem(reply.failure).pipe(Effect.map(Result.fail)),
    ),
  )
const decodeProblem = Schema.decodeUnknownSync(Rfc9457ProblemDetails, { onExcessProperty: 'error' })

const classify = (error: unknown): Omit<Rfc9457ProblemDetails, 'instance'> => {
  if (error instanceof RemoteWorkerError) {
    const validated = decodeRemoteProblemOption(error.cause)
    if (Option.isSome(validated)) return validated.value
  }
  if (error instanceof NotFound)
    return {
      type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#not-found',
      title: 'not-found',
      status: 404,
      detail: 'The requested resource was not found.',
    }
  if (error instanceof Conflict || error instanceof StorageConflict)
    return {
      type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#conflict',
      title: 'conflict',
      status: 409,
      detail: 'The operation conflicts with the current state.',
    }
  if (error instanceof InvalidOperation)
    return {
      type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#invalid-operation',
      title: 'invalid-operation',
      status: 409,
      detail: 'The operation is not allowed in the current state.',
    }
  if (error instanceof InvalidSnapshot)
    return {
      type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#invalid-snapshot',
      title: 'invalid-snapshot',
      status: 409,
      detail: 'The workflow state cannot be used for this operation.',
    }
  if (Schema.isSchemaError(error))
    return {
      type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#invalid-request',
      title: 'invalid-request',
      status: 400,
      detail: 'The request did not match the expected schema.',
    }
  if (error instanceof ExternalError && error.kind === 'storage')
    return {
      type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#storage',
      title: 'storage',
      status: 500,
      detail: 'A persistence operation failed.',
    }
  if (error instanceof ExternalError && error.kind === 'service')
    return {
      type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#service',
      title: 'service',
      status: 502,
      detail: 'A required service could not complete the operation.',
    }
  return {
    type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#internal',
    title: 'internal',
    status: 500,
    detail: 'The operation could not be completed.',
  }
}

/** Capture the native Crypto dependency once when composing a Worker implementation. */
export const makeRpcResponse = Effect.map(
  Crypto.Crypto,
  (crypto) =>
    (operation: string) =>
    <A extends Schema.Json, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<string, never, R> =>
      effect.pipe(
        Effect.flatMap((value) => encode(Result.succeed(value)).pipe(Effect.orDie)),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          return Effect.gen(function* () {
            const errorId = `urn:uuid:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`
            const error = Option.getOrUndefined(Cause.findErrorOption(cause))
            const problem = decodeProblem({ ...classify(error), instance: errorId })
            yield* Effect.logError('RPC operation failed', cause).pipe(
              Effect.annotateLogs({ operation, errorId: problem.instance }),
            )
            return yield* encode(Result.fail(problem)).pipe(Effect.orDie)
          })
        }),
      ),
)

/** Convenience adapter for effects whose composition root has not captured the responder. */
export const rpcResponse =
  (operation: string) =>
  <A extends Schema.Json, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<string, never, R | Crypto.Crypto> =>
    Effect.flatMap(makeRpcResponse, (respond) => respond(operation)(effect))

/** Validate the complete wire envelope, then create a fresh local failure. */
export const rpcResult =
  (operation: string) =>
  (response: unknown): Effect.Effect<Schema.Json, RemoteWorkerError | ExternalError> =>
    decode(response).pipe(
      // Never retain decoder diagnostics, which may contain secret-bearing peer bytes.
      Effect.mapError(
        () => new ExternalError({ operation, kind: 'service', cause: new Error('Invalid RPC response') }),
      ),
      Effect.flatMap((reply) =>
        Result.isSuccess(reply)
          ? Effect.succeed(reply.success)
          : Effect.fail(new RemoteWorkerError({ operation, cause: reply.failure })),
      ),
    )
