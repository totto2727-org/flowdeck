import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { encodeRpcError, ErrorTag, RpcCallError } from 'alchemy/Rpc'
import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { describe, expect, it, vi } from 'vite-plus/test'

import { ExternalError, InvalidOperation } from '../../../features/workflow/domain/errors'
import { Workflows } from '../../../features/workflow/services/workflows'
import { ApiRoutes } from './router'

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
  it.each([
    ['GET', '/api/workflows', undefined],
    ['GET', '/api/runs', undefined],
    ['GET', '/api/runs/run-1', undefined],
    ['POST', '/api/runs', '{"workflowId":"demo","version":"1.0.0"}'],
    ['POST', '/api/runs/run-1/resume', undefined],
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
    [
      new ExternalError({ operation: 'read run', cause: 'Database unavailable', kind: 'storage' }),
      500,
      { error: 'ExternalError', message: 'Persistence operation failed' },
    ],
    [
      new ExternalError({ operation: 'call workflow worker', cause: 'Disconnected', kind: 'service' }),
      502,
      { error: 'ExternalError', message: 'Workflow worker is unavailable. The run remains persisted' },
    ],
    [
      new InvalidOperation({ message: 'Explicit workflow recovery is required' }),
      409,
      {
        error: 'InvalidOperation',
        message: 'Explicit workflow recovery is required',
      },
    ],
    [
      new RpcCallError({ method: 'resume', cause: 'Individual worker disconnected' }),
      502,
      {
        error: 'ExternalError',
        message: 'Workflow worker is unavailable. The run remains persisted',
      },
    ],
  ] as const)('preserves the remote %s error envelope at the aggregate boundary', async (error, status, expected) => {
    const handler = api(
      makeRpcStub<Workflows['Service']>({
        resumeRun: () => Promise.resolve({ _tag: ErrorTag, error: encodeRpcError(error) }),
      }),
    )
    try {
      const response = await handler.handler(new Request('http://localhost/api/runs/run-1/resume', { method: 'POST' }))
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual(expected)
    } finally {
      await handler.dispose()
    }
  })

  it.each([
    ['GET', '/api/workflows', undefined],
    ['GET', '/api/runs', undefined],
    ['GET', '/api/runs/run-1', undefined],
    ['POST', '/api/runs', '{"workflowId":"demo","version":"1.0.0"}'],
    ['POST', '/api/runs/run-1/resume', undefined],
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
    ['/api/runs/run-1/resume', undefined],
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
