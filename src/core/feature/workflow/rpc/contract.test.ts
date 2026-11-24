import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { ErrorTag } from 'alchemy/Rpc'
import { Cause, Context, Effect, Exit, Layer, Logger, Option, Schema } from 'effect'
import { HttpRouter } from 'effect/http'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { Conflict, ExternalError } from '@/core/feature/workflow/domain/errors'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { ApiRoutes } from '@/core/worker/control/feature/router'

import { rpcResponse } from './boundary.ts'
import {
  RpcRunsResponse,
  RpcWorkflowsResponse,
  encodeRunsResponse,
  rpcCall,
  rpcCommandResult,
  rpcValue,
  type WireWorkflowExecutor,
  type WireWorkflowService,
} from './contract.ts'
import { RemoteWorkerError } from './problem.ts'

const decodeRpcRunsResponse = Schema.decodeUnknownSync(RpcRunsResponse)

const response = <A extends Schema.Json>(value: A) =>
  Effect.runSync(Effect.succeed(value).pipe(rpcResponse('child.test'), Effect.provide(BrowserCrypto.layer)))

describe('workflow RPC value contracts', () => {
  live('classifies invalid server-produced domain values as internal errors rather than bad requests', () =>
    Effect.gen(function* () {
      const valid = decodeRpcRunsResponse({
        runs: [
          {
            runId: 'run_00000000-0000-4000-8000-000000000001',
            workflowId: 'example',
            workflowVersion: '1.0.0',
            graphId: 'example_v1',
            status: 'pending',
            revision: 0,
            snapshot: {},
            createdAt: '2026-11-08T00:00:00.000Z',
            updatedAt: '2026-11-08T00:00:00.000Z',
          },
        ],
      })
      const output = { runs: valid.runs.map((run) => ({ ...run, revision: -1 })) }
      const reply = yield* encodeRunsResponse(output).pipe(
        rpcResponse('Workflow.listRuns'),
        Effect.provide(BrowserCrypto.layer),
        Effect.provide(Logger.layer([Logger.make(() => undefined)])),
      )
      const failure = yield* rpcValue('Workflow.listRuns', RpcRunsResponse)(reply).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(RemoteWorkerError)
      expect(failure).toMatchObject({ cause: { status: 500, title: 'internal' } })
    }),
  )

  test('exposes JSON text rather than domain values or typed failures on the wire', () => {
    expectTypeOf<Effect.Success<ReturnType<WireWorkflowService['listRuns']>>>().toEqualTypeOf<string>()
    expectTypeOf<Effect.Error<ReturnType<WireWorkflowService['listRuns']>>>().toEqualTypeOf<never>()
    expectTypeOf<Effect.Success<ReturnType<WireWorkflowExecutor['start']>>>().toEqualTypeOf<string>()
    expectTypeOf<Effect.Error<ReturnType<WireWorkflowExecutor['start']>>>().toEqualTypeOf<never>()
  })

  live('decodes the successful operation value after validating the envelope', () =>
    Effect.gen(function* () {
      expect(
        yield* rpcValue('Workflow.listWorkflows', RpcWorkflowsResponse)(response({ workflows: [] })),
      ).toStrictEqual({
        workflows: [],
      })
    }),
  )

  live('accepts only JSON null as a successful command acknowledgement', () =>
    Effect.gen(function* () {
      expect(yield* rpcCommandResult('DemoWorkflow.start')(response(null))).toBeUndefined()
      const result = yield* Effect.exit(rpcCommandResult('DemoWorkflow.start')(response({ unexpected: true })))
      expect(result).toMatchObject({ _tag: 'Failure' })
    }),
  )

  live('treats an invalid operation value as a local service failure without retaining peer data', () =>
    Effect.gen(function* () {
      const result = yield* rpcValue(
        'Workflow.listWorkflows',
        RpcWorkflowsResponse,
      )(response({ private: 'private peer data' })).pipe(Effect.flip)
      expect(result).toMatchObject({
        _tag: 'ExternalError',
        cause: { message: 'RPC response does not match the expected value schema' },
        kind: 'service',
        operation: 'Workflow.listWorkflows',
      })
      expect(String(result.cause)).not.toContain('private peer data')
    }),
  )
})

describe('native SDK RPC client boundary', () => {
  test('passes a successful SDK command reply to the application decoder unchanged', async () => {
    const text = response(null)
    const rpc = makeRpcStub<WireWorkflowExecutor>(Effect.succeed({ start: async () => text }))
    await expect(
      Effect.runPromise(
        rpc
          .start('run_00000000-0000-4000-8000-000000000001')
          .pipe(rpcCall('DemoWorkflow.start'), Effect.flatMap(rpcCommandResult('DemoWorkflow.start'))),
      ),
    ).resolves.toBeUndefined()
  })

  live('does not retain malformed successful SDK reply bytes during application decoding', () =>
    Effect.gen(function* () {
      const rpc = makeRpcStub<WireWorkflowService>(Effect.succeed({ listRuns: async () => 'PRIVATE_PEER_BYTES' }))
      const local = yield* rpc
        .listRuns()
        .pipe(rpcCall('Workflow.listRuns'), Effect.flatMap(rpcValue('Workflow.listRuns', RpcRunsResponse)), Effect.flip)
      expect(local).toBeInstanceOf(ExternalError)
      expect(local).toMatchObject({ cause: { message: 'Invalid RPC response' } })
      expect(Cause.pretty(Cause.fail(local))).not.toContain('PRIVATE_PEER_BYTES')
    }),
  )

  test.each(['SDK error envelope', 'rejected call', 'SDK defect'] as const)(
    'discards origin diagnostics from a %s before the parent HTTP operation logs',
    async (scenario) => {
      const origin = new Error('PRIVATE_ORIGIN_MESSAGE', { cause: { password: 'PRIVATE_ORIGIN_SECRET' } })
      origin.stack = 'Error: PRIVATE_ORIGIN_MESSAGE\n at PRIVATE_ORIGIN_STACK (child.ts:1:1)'
      const peer = {
        listRuns: async () => {
          if (scenario === 'rejected call') {
            throw origin
          }
          return {
            _tag: ErrorTag,
            error: {
              _tag: 'ExternalError',
              message: origin.message,
              stack: origin.stack,
              cause: origin.cause,
            },
          }
        },
      }
      const rpc = makeRpcStub<WireWorkflowService>(
        scenario === 'SDK defect' ? Effect.die(origin) : Effect.succeed(peer),
      )
      const listRuns = () =>
        rpc
          .listRuns()
          .pipe(rpcCall('Workflow.listRuns'), Effect.flatMap(rpcValue('Workflow.listRuns', RpcRunsResponse)))
      const local = await Effect.runPromise(listRuns().pipe(Effect.flip))
      expect(local).toBeInstanceOf(ExternalError)
      expect(local).toMatchObject({
        cause: { message: 'RPC service call failed' },
        kind: 'service',
        operation: 'Workflow.listRuns',
      })
      expect(local.cause).toBeInstanceOf(Error)
      expect(local.cause).not.toBe(origin)
      expect(Cause.pretty(Cause.fail(local))).not.toContain('PRIVATE_ORIGIN')

      const unused = () => Effect.die('Unused regression operation')
      const workflows: Workflows['Service'] = {
        listRuns,
        listWorkflows: unused,
        getRunDetail: unused,
        createRun: unused,
        resumeRun: unused,
      }
      const entries: Array<Logger.Options<unknown>> = []
      const logger = Logger.make((entry) => entries.push(entry))
      const handler = HttpRouter.toWebHandler(
        ApiRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(Workflows, workflows))),
      )
      try {
        const reply = await handler.handler(
          new Request('http://localhost/api/runs'),
          Context.make(Logger.CurrentLoggers, new Set([logger])),
        )
        expect(reply.status).toBe(502)
        await expect(reply.text()).resolves.not.toContain('PRIVATE_ORIGIN')
        expect(entries).toHaveLength(1)
        const logged = Option.getOrThrow(Cause.findErrorOption(entries[0]!.cause))
        expect(logged).toBeInstanceOf(ExternalError)
        expect(logged).toMatchObject({ cause: { message: 'RPC service call failed' } })
        expect(JSON.stringify(logged)).not.toContain('PRIVATE_ORIGIN')
        expect(Cause.pretty(entries[0]!.cause)).not.toContain('PRIVATE_ORIGIN')
      } finally {
        await handler.dispose()
      }
    },
  )

  live('preserves validated application problems after the SDK call boundary', () =>
    Effect.gen(function* () {
      const text = yield* Effect.fail(new Conflict({ message: 'private conflict' })).pipe(
        rpcResponse('child'),
        Effect.provide(BrowserCrypto.layer),
        Effect.provide(Logger.layer([Logger.make(() => undefined)])),
      )
      const rpc = makeRpcStub<WireWorkflowService>(Effect.succeed({ listRuns: async () => text }))
      const local = yield* rpc
        .listRuns()
        .pipe(rpcCall('Workflow.listRuns'), Effect.flatMap(rpcValue('Workflow.listRuns', RpcRunsResponse)), Effect.flip)
      expect(local).toBeInstanceOf(RemoteWorkerError)
      expect(local).toMatchObject({
        cause: { title: 'conflict', status: 409 },
        operation: 'Workflow.listRuns',
      })
      expect(Cause.pretty(Cause.fail(local))).not.toContain('private conflict')
    }),
  )

  live('preserves a cancellation-only cause without creating a local service failure', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.interrupt.pipe(rpcCall('cancelled SDK call')))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
    }),
  )
})
