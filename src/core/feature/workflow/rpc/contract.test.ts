import { live } from '@effect/vitest'
import { Array, Effect, Exit, Option, Schema } from 'effect'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { ExternalError } from '@/core/feature/workflow/domain/errors'

import { jsonAcknowledgement, response, wireReply } from './contract-reply.fixture.ts'
import { encodeRunsResponse, RpcRunsResponse, RpcWorkflowsResponse, rpcCommandResult, rpcValue } from './contract.ts'
import type { WireWorkflowExecutor, WireWorkflowService } from './contract.ts'
import { RemoteWorkerError } from './problem.ts'

const decodeRpcRunsResponse = Schema.decodeEffect(RpcRunsResponse)
const invalidRevision = -1
const runWireValue = {
  createdAt: '2026-11-08T00:00:00.000Z',
  graphId: 'example_v1',
  revision: 0,
  runId: 'run_00000000-0000-4000-8000-000000000001',
  snapshot: {},
  status: 'pending',
  updatedAt: '2026-11-08T00:00:00.000Z',
  workflowId: 'example',
  workflowVersion: '1.0.0',
} as const

live('classifies invalid server-produced domain values as internal errors rather than bad requests', () =>
  Effect.gen(function* () {
    const valid = yield* decodeRpcRunsResponse({ runs: [runWireValue] })
    const run = Option.getOrThrow(Array.head(valid.runs))
    const output = { runs: [{ ...run, revision: invalidRevision }] }
    const reply = yield* wireReply('Workflow.listRuns', encodeRunsResponse(output))
    const failure = yield* rpcValue('Workflow.listRuns', RpcRunsResponse)(reply).pipe(Effect.flip)
    expect(failure).toBeInstanceOf(RemoteWorkerError)
    expect(failure).toMatchObject({ cause: { status: 500, title: 'internal' } })
  }),
)

describe('workflow RPC wire types', () => {
  test('exposes JSON text rather than domain values or typed failures on the wire', () => {
    expectTypeOf<Effect.Success<ReturnType<WireWorkflowService['listRuns']>>>().toEqualTypeOf<string>()
    expectTypeOf<Effect.Error<ReturnType<WireWorkflowService['listRuns']>>>().toEqualTypeOf<never>()
    expectTypeOf<Effect.Success<ReturnType<WireWorkflowExecutor['start']>>>().toEqualTypeOf<string>()
    expectTypeOf<Effect.Error<ReturnType<WireWorkflowExecutor['start']>>>().toEqualTypeOf<never>()
  })
})

live('decodes the successful operation value after validating the envelope', () =>
  Effect.gen(function* () {
    const reply = yield* response({ workflows: [] })
    expect(yield* rpcValue('Workflow.listWorkflows', RpcWorkflowsResponse)(reply)).toStrictEqual({ workflows: [] })
  }),
)

live('accepts only JSON null as a successful command acknowledgement', () =>
  Effect.gen(function* () {
    const reply = yield* response(jsonAcknowledgement)
    expect(yield* rpcCommandResult('DemoWorkflow.start')(reply)).toBeUndefined()
    const invalid = yield* response({ unexpected: true })
    const result = yield* Effect.exit(rpcCommandResult('DemoWorkflow.start')(invalid))
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

live('treats an invalid operation value as a local service failure without retaining peer data', () =>
  Effect.gen(function* () {
    const reply = yield* response({ private: 'private peer data' })
    const read = rpcValue('Workflow.listWorkflows', RpcWorkflowsResponse)
    const result = yield* read(reply).pipe(Effect.flip)
    expect(result).toBeInstanceOf(ExternalError)
    expect(result).toMatchObject({
      cause: { message: 'RPC response does not match the expected value schema' },
      kind: 'service',
      operation: 'Workflow.listWorkflows',
    })
    expect(String(result.cause)).not.toContain('private peer data')
  }),
)
