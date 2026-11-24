import { live } from '@effect/vitest'
import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { Cause, Effect, Exit, Function, Predicate } from 'effect'
import { expect } from 'vite-plus/test'

import { Conflict, ExternalError } from '@/core/feature/workflow/domain/errors'
import { rpcCall, rpcCommandResult, RpcRunsResponse, rpcValue } from '@/core/feature/workflow/rpc/contract'
import type { WireWorkflowExecutor, WireWorkflowService } from '@/core/feature/workflow/rpc/contract'
import { jsonAcknowledgement, response, wireReply } from '@/core/feature/workflow/rpc/contract-reply.fixture'
import { RemoteWorkerError } from '@/core/feature/workflow/rpc/problem'

import { makeOriginCall, observeParentHttp, originScenarios } from './fixtures/rpc-contract-sdk-diagnostics.ts'

const needRuns = 'Workflow.listRuns'
const startRun = 'DemoWorkflow.start'
const runId = 'run_00000000-0000-4000-8000-000000000001'
const privatePeer = 'PRIVATE_PEER_BYTES'
const privateOrigin = 'PRIVATE_ORIGIN'
const decodeRuns = rpcValue(needRuns, RpcRunsResponse)

live('passes a successful SDK command reply to the application decoder unchanged', () =>
  Effect.gen(function* () {
    const text = yield* response(jsonAcknowledgement)
    const start = Function.constant(Promise.resolve(text))
    const rpc = makeRpcStub<WireWorkflowExecutor>(Effect.succeed({ start }))
    const call = rpc.start(runId).pipe(rpcCall(startRun))
    const decode = rpcCommandResult(startRun)
    expect(yield* call.pipe(Effect.flatMap(decode))).toBeUndefined()
  }),
)

live('does not retain malformed successful SDK reply bytes during application decoding', () =>
  Effect.gen(function* () {
    const listRuns = Function.constant(Promise.resolve(privatePeer))
    const rpc = makeRpcStub<WireWorkflowService>(Effect.succeed({ listRuns }))
    const call = rpc.listRuns().pipe(rpcCall(needRuns))
    const local = yield* call.pipe(Effect.flatMap(decodeRuns), Effect.flip)
    expect(local).toBeInstanceOf(ExternalError)
    expect(local).toMatchObject({ cause: { message: 'Invalid RPC response' } })
    expect(Cause.pretty(Cause.fail(local))).not.toContain(privatePeer)
  }),
)

live.each(originScenarios)('discards origin diagnostics from a %s before the parent HTTP operation logs', (scenario) =>
  Effect.gen(function* () {
    const { listRuns, origin } = makeOriginCall(scenario)
    const local = yield* listRuns().pipe(Effect.flip)
    expect({
      causeIsError: Predicate.isError(local.cause),
      originRendered: Cause.pretty(Cause.fail(local)).includes(privateOrigin),
      originRetained: local.cause === origin,
      typedFailure: local instanceof ExternalError,
    }).toStrictEqual({ causeIsError: true, originRendered: false, originRetained: false, typedFailure: true })
    expect(local).toMatchObject({
      cause: { message: 'RPC service call failed' },
      kind: 'service',
      operation: needRuns,
    })

    const parent = yield* observeParentHttp(listRuns)
    expect({
      bodyRetainsOrigin: parent.body.includes(privateOrigin),
      entries: parent.entries.length,
      loggedRetainsOrigin: JSON.stringify(parent.logged).includes(privateOrigin),
      prettyRetainsOrigin: parent.pretty.includes(privateOrigin),
      status: parent.status,
    }).toStrictEqual({
      bodyRetainsOrigin: false,
      entries: 1,
      loggedRetainsOrigin: false,
      prettyRetainsOrigin: false,
      status: 502,
    })
    expect(parent.logged).toBeInstanceOf(ExternalError)
    expect(parent.logged).toMatchObject({ cause: { message: 'RPC service call failed' } })
  }).pipe(Effect.scoped),
)

live('preserves validated application problems after the SDK call boundary', () =>
  Effect.gen(function* () {
    const failure = Effect.fail(new Conflict({ message: 'private conflict' }))
    const text = yield* wireReply('child', failure)
    const listRuns = Function.constant(Promise.resolve(text))
    const rpc = makeRpcStub<WireWorkflowService>(Effect.succeed({ listRuns }))
    const call = rpc.listRuns().pipe(rpcCall(needRuns))
    const local = yield* call.pipe(Effect.flatMap(decodeRuns), Effect.flip)
    expect(local).toBeInstanceOf(RemoteWorkerError)
    expect(local).toMatchObject({ cause: { status: 409, title: 'conflict' }, operation: needRuns })
    expect(Cause.pretty(Cause.fail(local))).not.toContain('private conflict')
  }),
)

live('preserves a cancellation-only cause without creating a local service failure', () =>
  Effect.gen(function* () {
    const outcome = yield* Effect.exit(Effect.interrupt.pipe(rpcCall('cancelled SDK call')))
    const interrupted = Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause)
    expect(interrupted).toBe(true)
  }),
)
