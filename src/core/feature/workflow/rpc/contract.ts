import { Cause, Data, Effect, Schema, flow } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'
import { CreateRun, RunDetail, RunsResponse, WorkflowsResponse } from '@/core/feature/workflow/domain/model'

import { rpcResult } from './boundary.ts'
import type { RemoteWorkerError } from './problem.ts'

export const RpcCreateRun = Schema.toCodecJson(CreateRun)
export const RpcRunDetail = Schema.toCodecJson(RunDetail)
export const RpcRunsResponse = Schema.toCodecJson(RunsResponse)
export const RpcWorkflowsResponse = Schema.toCodecJson(WorkflowsResponse)

// Invalid server-produced values are defects, not checked inbound request failures.
export const encodeWorkflowsResponse = flow(Schema.encodeEffect(RpcWorkflowsResponse), Effect.orDie)
export const encodeRunsResponse = flow(Schema.encodeEffect(RpcRunsResponse), Effect.orDie)
export const encodeRunDetail = flow(Schema.encodeEffect(RpcRunDetail), Effect.orDie)

export type WireWorkflowService<R = never> = Readonly<{
  listWorkflows: () => Effect.Effect<string, never, R>
  listRuns: () => Effect.Effect<string, never, R>
  getRunDetail: (runId: RunId) => Effect.Effect<string, never, R>
  createRun: (input: typeof RpcCreateRun.Encoded) => Effect.Effect<string, never, R>
  resumeRun: (runId: RunId) => Effect.Effect<string, never, R>
}>

export type WireWorkflowExecutor<R = never> = Readonly<{
  start: (runId: RunId) => Effect.Effect<string, never, R>
  resume: (runId: RunId) => Effect.Effect<string, never, R>
}>

class RpcBoundaryFailure extends Data.TaggedError('RpcBoundaryFailure')<Readonly<{ message: string }>> {}

const rpcFailure = (operation: string, message: string): ExternalError =>
  new ExternalError({ cause: new RpcBoundaryFailure({ message }), kind: 'service', operation })

/*
 * Apply only to the native Alchemy RPC call, before decoding its application reply.
 * The official stub decodes SDK error envelopes into failures before rpcValue can
 * validate the JSON-only protocol, and exposes no client error middleware hook.
 * Its failures and defects can therefore contain arbitrary peer diagnostics.
 * Replace those at this smallest SDK boundary, before a parent operation logs
 * them. Decode afterward so validated RemoteWorkerError problems remain intact.
 */
export const rpcCall =
  (operation: string) =>
  <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, ExternalError, R> =>
    call.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(rpcFailure(operation, 'RPC service call failed')),
      ),
    )

type RpcReplyFailure = ExternalError | RemoteWorkerError
type DecodeReply<S extends Schema.Constraint> = (
  response: unknown,
) => Effect.Effect<S['Type'], RpcReplyFailure, S['DecodingServices']>

const makeRpcValueDecoder = <S extends Schema.Constraint>(schema: S): ((operation: string) => DecodeReply<S>) => {
  // oxlint-disable-next-line rules/require-top-level-decoder, rules/prefer-non-unknown-decode -- This factory receives a runtime schema and validates an untrusted peer value against it.
  const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })
  return (operation: string) => (response: unknown) =>
    rpcResult(operation)(response).pipe(
      Effect.flatMap(decode),
      Effect.catchTag('SchemaError', () =>
        Effect.fail(rpcFailure(operation, 'RPC response does not match the expected value schema')),
      ),
    )
}

export const rpcValue = <S extends Schema.Constraint>(operation: string, schema: S): DecodeReply<S> =>
  makeRpcValueDecoder(schema)(operation)

const decodeCommandReply = makeRpcValueDecoder(Schema.Null)
export const rpcCommandResult = (operation: string): ((response: unknown) => Effect.Effect<void, RpcReplyFailure>) =>
  flow(decodeCommandReply(operation), Effect.asVoid)
