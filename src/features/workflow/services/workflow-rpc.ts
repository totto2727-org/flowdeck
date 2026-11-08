import { Cause, Effect, Schema } from 'effect'

import { rpcResult } from '../../rpc-boundary'
import { ExternalError } from '../domain/errors'
import type { RunId } from '../domain/identity'
import { CreateRun, RunDetail, RunsResponse, WorkflowsResponse } from '../domain/model'

export const RpcCreateRun = Schema.toCodecJson(CreateRun)
export const RpcRunDetail = Schema.toCodecJson(RunDetail)
export const RpcRunsResponse = Schema.toCodecJson(RunsResponse)
export const RpcWorkflowsResponse = Schema.toCodecJson(WorkflowsResponse)

// Invalid server-produced values are defects, not checked inbound request failures.
export const encodeWorkflowsResponse = (value: typeof RpcWorkflowsResponse.Type) =>
  Schema.encodeEffect(RpcWorkflowsResponse)(value).pipe(Effect.orDie)
export const encodeRunsResponse = (value: typeof RpcRunsResponse.Type) =>
  Schema.encodeEffect(RpcRunsResponse)(value).pipe(Effect.orDie)
export const encodeRunDetail = (value: typeof RpcRunDetail.Type) =>
  Schema.encodeEffect(RpcRunDetail)(value).pipe(Effect.orDie)

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

export const rpcValue =
  <S extends Schema.Constraint>(operation: string, schema: S) =>
  (response: unknown) =>
    rpcResult(operation)(response).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })),
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

export const rpcCommandResult = (operation: string) => (response: unknown) =>
  rpcValue(operation, Schema.Null)(response).pipe(Effect.asVoid)
