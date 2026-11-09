import { Cause, Effect, Schema, flow } from 'effect'

import { ExternalError } from '@/features/workflow/domain/errors'
import type { RunId } from '@/features/workflow/domain/identity'
import { CreateRun, RunDetail, RunsResponse, WorkflowsResponse } from '@/features/workflow/domain/model'

import { rpcResult } from './boundary'

export const RpcCreateRun = Schema.toCodecJson(CreateRun)
export const RpcRunDetail = Schema.toCodecJson(RunDetail)
export const RpcRunsResponse = Schema.toCodecJson(RunsResponse)
export const RpcWorkflowsResponse = Schema.toCodecJson(WorkflowsResponse)

// Invalid server-produced values are defects, not checked inbound request failures.
export const encodeWorkflowsResponse = flow(Schema.encodeEffect(RpcWorkflowsResponse), Effect.orDie)
export const encodeRunsResponse = flow(Schema.encodeEffect(RpcRunsResponse), Effect.orDie)
export const encodeRunDetail = flow(Schema.encodeEffect(RpcRunDetail), Effect.orDie)

export type WireWorkflowService<R = never> = {
  readonly listWorkflows: () => Effect.Effect<string, never, R>
  readonly listRuns: () => Effect.Effect<string, never, R>
  readonly getRunDetail: (runId: RunId) => Effect.Effect<string, never, R>
  readonly createRun: (input: typeof RpcCreateRun.Encoded) => Effect.Effect<string, never, R>
  readonly resumeRun: (runId: RunId) => Effect.Effect<string, never, R>
}

export type WireWorkflowExecutor<R = never> = {
  readonly start: (runId: RunId) => Effect.Effect<string, never, R>
  readonly resume: (runId: RunId) => Effect.Effect<string, never, R>
}

/**
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
          : Effect.fail(new ExternalError({ operation, kind: 'service', cause: new Error('RPC service call failed') })),
      ),
    )

const makeRpcValueDecoder = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })
  return (operation: string) => (response: unknown) =>
    rpcResult(operation)(response).pipe(
      Effect.flatMap(decode),
      Effect.catchTag('SchemaError', () =>
        Effect.fail(
          new ExternalError({
            operation,
            kind: 'service',
            cause: new Error('RPC response does not match the expected value schema'),
          }),
        ),
      ),
    )
}

export const rpcValue = <S extends Schema.Constraint>(operation: string, schema: S) =>
  makeRpcValueDecoder(schema)(operation)

const decodeCommandReply = makeRpcValueDecoder(Schema.Null)
export const rpcCommandResult = (operation: string) => flow(decodeCommandReply(operation), Effect.asVoid)
