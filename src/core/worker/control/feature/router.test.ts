import { ok } from 'node:assert/strict'

import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { RpcCallError } from 'alchemy/Rpc'
import { Crypto, Effect, Layer, Schema, DateTime } from 'effect'
import { HttpRouter } from 'effect/http'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  Conflict,
  ExternalError,
  InvalidOperation,
  InvalidSnapshot,
  NotFound,
  StorageConflict,
} from '@/core/feature/workflow/domain/errors'
import { rpcResponse, rpcResult } from '@/core/feature/workflow/rpc/boundary'
import { RpcCreateRun, RpcRunDetail, RpcWorkflowsResponse } from '@/core/feature/workflow/rpc/contract'
import { RemoteWorkerError } from '@/core/feature/workflow/rpc/problem'
import { Workflows } from '@/core/feature/workflow/services/workflows'

import { ApiRoutes } from './router'

const crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (_algorithm, bytes) => Effect.succeed(bytes),
})

const api = (workflows: Workflows['Service']) =>
  HttpRouter.toWebHandler(ApiRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(Workflows, workflows))))

const unavailable = () =>
  Effect.fail(
    new ExternalError({
      operation: 'call workflow worker',
      cause: 'Workflow integration worker unavailable',
      kind: 'service',
    }),
  )
const unavailableWorkflows: Workflows['Service'] = {
  listWorkflows: unavailable,
  listRuns: unavailable,
  getRunDetail: unavailable,
  createRun: unavailable,
  resumeRun: unavailable,
}

// Native requests exercise Control's public HTTP boundary with only its aggregate service supplied.
describe('Control aggregate Workflow service boundary', () => {
  it('serializes domain SemVer catalog values as HTTP strings', async () => {
    const workflows = [
      {
        workflowId: 'demo',
        name: 'Demo',
        versions: [Schema.decodeUnknownSync(Schema.SemVerFromString)('1.0.0')],
        inputs: [],
      },
    ]
    const handler = api({ ...unavailableWorkflows, listWorkflows: () => Effect.succeed({ workflows }) })
    try {
      const response = await handler.handler(new Request('http://localhost/api/workflows'))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ workflows: [{ ...workflows[0], versions: ['1.0.0'] }] })
    } finally {
      await handler.dispose()
    }
  })

  it('encodes timestamp and event variants for RPC without losing domain values', () => {
    const runId = 'run_00000000-0000-4000-8000-000000000001'
    const timestamp = DateTime.makeUnsafe('2026-10-31T00:00:00.000Z')
    const snapshot = { nested: { valid: [true, null, 1] } }
    const detail = {
      run: {
        runId,
        workflowId: 'demo',
        workflowVersion: Schema.decodeUnknownSync(Schema.SemVerFromString)('1.0.0'),
        graphId: 'graph-1',
        status: 'running',
        revision: 1,
        snapshot,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      graph: { graphId: 'graph-1', schemaVersion: 1, nodes: [], edges: [] },
      state: { runId, revision: 1, snapshot },
      events: [
        {
          eventId: 'event_00000000-0000-4000-8000-000000000001',
          runId,
          sequence: 1,
          type: 'run.started',
          payload: {},
          createdAt: timestamp,
        },
        {
          eventId: 'event_00000000-0000-4000-8000-000000000002',
          runId,
          sequence: 2,
          type: 'node.started',
          nodeId: 'prepare',
          executionId: 'execution_00000000-0000-4000-8000-000000000001',
          attempt: 1,
          payload: {},
          createdAt: timestamp,
        },
      ],
      shapes: { nodes: [], edges: [] },
    } as const
    const encoded = Schema.encodeSync(RpcRunDetail)(detail)
    expect(encoded).toMatchObject({
      run: { workflowVersion: '1.0.0', createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z' },
      events: [
        { type: 'run.started', createdAt: '2026-10-31T00:00:00.000Z' },
        { type: 'node.started', nodeId: 'prepare', attempt: 1 },
      ],
    })
    expect(Schema.decodeUnknownSync(RpcRunDetail, { onExcessProperty: 'error' })(structuredClone(encoded))).toEqual(
      detail,
    )
    const invalid = {
      ...Schema.decodeUnknownSync(Schema.JsonObject)(encoded),
      events: [{ ...detail.events[0], createdAt: DateTime.formatIso(timestamp), nodeId: null }],
    }
    expect(() => Schema.decodeUnknownSync(RpcRunDetail, { onExcessProperty: 'error' })(invalid)).toThrow()
  })

  it('round trips create input SemVer through native RPC-compatible values', () => {
    const input = { workflowId: 'demo', version: Schema.decodeUnknownSync(Schema.SemVerFromString)('1.2.3') }
    const encodedInput = Schema.encodeSync(RpcCreateRun)(input)
    expect(encodedInput).toEqual({ workflowId: 'demo', version: '1.2.3' })
    expect(Schema.decodeUnknownSync(RpcCreateRun)(structuredClone(encodedInput))).toEqual(input)
  })

  it('round trips catalog SemVer through native RPC-compatible values', () => {
    const version = Schema.decodeUnknownSync(Schema.SemVerFromString)('1.2.3')
    const catalog = { workflows: [{ workflowId: 'demo', name: 'Demo', versions: [version], inputs: [] }] }
    const encodedCatalog = Schema.encodeSync(RpcWorkflowsResponse)(catalog)
    expect(encodedCatalog).toEqual({
      workflows: [{ workflowId: 'demo', name: 'Demo', versions: ['1.2.3'], inputs: [] }],
    })
    expect(Schema.decodeUnknownSync(RpcWorkflowsResponse)(structuredClone(encodedCatalog))).toEqual(catalog)
  })
  it.each([
    '00000000-0000-4000-8000-000000000001',
    'not-a-run-id',
    'event_00000000-0000-4000-8000-000000000001',
    'run_01890f2e-7b55-7cc1-8c5a-000000000001',
  ])('rejects malformed run ID %s before calling the workflow service', async (id) => {
    const getRunDetail = vi.fn(unavailable)
    const resumeRun = vi.fn(unavailable)
    const handler = api({ ...unavailableWorkflows, getRunDetail, resumeRun })
    try {
      const read = await handler.handler(new Request(`http://localhost/api/runs/${id}`))
      const resume = await handler.handler(new Request(`http://localhost/api/runs/${id}/resume`, { method: 'POST' }))
      expect(read.status).toBe(400)
      expect(resume.status).toBe(400)
      expect(getRunDetail).not.toHaveBeenCalled()
      expect(resumeRun).not.toHaveBeenCalled()
    } finally {
      await handler.dispose()
    }
  })

  it.each([
    ['GET', '/api/workflows', undefined],
    ['GET', '/api/runs', undefined],
    ['GET', '/api/runs/run_00000000-0000-4000-8000-000000000001', undefined],
    ['POST', '/api/runs', '{"workflowId":"demo","version":"1.0.0"}'],
    ['POST', '/api/runs/run_00000000-0000-4000-8000-000000000001/resume', undefined],
  ] as const)('returns 502 for %s %s when native RPC transport rejects', async (method, path, body) => {
    // Native promises model the Cloudflare RPC target, not an Effect service failure.
    const reject = () => Promise.reject(new Error('Service binding disconnected'))
    const handler = api(
      makeRpcStub<Workflows['Service']>({
        listWorkflows: reject,
        listRuns: reject,
        getRunDetail: reject,
        createRun: reject,
        resumeRun: reject,
      }),
    )
    try {
      const response = await handler.handler(
        new Request(
          `http://localhost${path}`,
          body === undefined ? { method } : { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        ),
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: 'ExternalError' })
    } finally {
      await handler.dispose()
    }
  })

  it.each([
    [new NotFound({ resource: 'private graph' }), 404, 'NotFound'],
    [new Conflict({ message: 'private conflict' }), 409, 'Conflict'],
    [
      new StorageConflict({ operation: 'batch', message: 'private constraint', cause: new Error('private SQL') }),
      409,
      'Conflict',
    ],
    [new InvalidOperation({ message: 'private recovery information' }), 409, 'InvalidOperation'],
    [new InvalidSnapshot({ message: 'private checkpoint' }), 409, 'InvalidSnapshot'],
    [
      new ExternalError({ operation: 'read run', cause: 'private database failure', kind: 'storage' }),
      500,
      'ExternalError',
    ],
    [
      new ExternalError({ operation: 'call workflow worker', cause: 'private disconnection', kind: 'service' }),
      502,
      'ExternalError',
    ],
    [new RpcCallError({ method: 'resume', cause: 'private disconnection' }), 500, 'ExternalError'],
    [Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(Schema.String)(null))), 400, 'InvalidRequest'],
    [new Error('private unexpected failure'), 500, 'ExternalError'],
  ] as const)(
    'maps a fresh local error from remote %s to HTTP %s without reviving its cause',
    async (error, status, code) => {
      const responseText = await Effect.runPromise(
        Effect.fail(error).pipe(rpcResponse('Workflow.resumeRun'), Effect.provideService(Crypto.Crypto, crypto)),
      )
      expect(responseText).not.toContain('private')
      expect(responseText).not.toContain('stack')
      const local = await Effect.runPromise(Effect.flip(rpcResult('Control.resumeRun')(responseText)))
      ok(local instanceof RemoteWorkerError)
      expect(local).not.toBe(error)
      const handler = api({
        ...unavailableWorkflows,
        resumeRun: () => Effect.fail(local),
      })
      try {
        const response = await handler.handler(
          new Request('http://localhost/api/runs/run_00000000-0000-4000-8000-000000000001/resume', { method: 'POST' }),
        )
        expect(response.status).toBe(status)
        const body = await response.json()
        expect(body).toEqual({ error: code, message: local.cause.detail })
        expect(JSON.stringify(body)).not.toContain('private')
        expect(body).not.toHaveProperty('stack')
        expect(body).not.toHaveProperty('cause')
      } finally {
        await handler.dispose()
      }
    },
  )

  it.each([
    ['GET', '/api/workflows', undefined],
    ['GET', '/api/runs', undefined],
    ['GET', '/api/runs/run_00000000-0000-4000-8000-000000000001', undefined],
    ['POST', '/api/runs', '{"workflowId":"demo","version":"1.0.0"}'],
    ['POST', '/api/runs/run_00000000-0000-4000-8000-000000000001/resume', undefined],
  ] as const)('returns 502 for %s %s when the aggregate worker is unavailable', async (method, path, body) => {
    const handler = api(unavailableWorkflows)
    try {
      const response = await handler.handler(
        new Request(
          `http://localhost${path}`,
          body === undefined ? { method } : { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        ),
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: 'ExternalError' })
    } finally {
      await handler.dispose()
    }
  })

  it.each([
    ['/api/runs', '{"workflowId":"demo","version":"1.0.0"}'],
    ['/api/runs', 'not JSON'],
    ['/api/runs/run_00000000-0000-4000-8000-000000000001/resume', undefined],
  ] as const)('rejects browser-originated %s requests before calling Workflows with body %s', async (path, body) => {
    const createRun = vi.fn(unavailable)
    const resumeRun = vi.fn(unavailable)
    const handler = api({ ...unavailableWorkflows, createRun, resumeRun })
    try {
      const response = await handler.handler(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
          ...(body === undefined ? {} : { body }),
        }),
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: 'Forbidden',
        message: 'Browser-originated control mutations are not allowed',
      })
      expect(createRun).not.toHaveBeenCalled()
      expect(resumeRun).not.toHaveBeenCalled()
    } finally {
      await handler.dispose()
    }
  })
})
