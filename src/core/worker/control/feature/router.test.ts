import { live } from '@effect/vitest'
import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { Effect, Schema } from 'effect'
import { expect, vi } from 'vite-plus/test'

import type { Workflows } from '@/core/feature/workflow/services/workflows'

import {
  catalogPath,
  createBody,
  createRequest,
  openApi,
  post,
  responseJson,
  resumePath,
  runPath,
  runsPath,
  unavailable,
  unavailableWorkflows,
} from './control-api.fixture.ts'

const httpOk = 200
const httpBadRequest = 400
const httpForbidden = 403
const httpBadGateway = 502
const decodeVersion = Schema.decodeEffect(Schema.SemVerFromString)
const textOrigin = { 'content-type': 'text/plain', origin: 'https://evil.example' }
const loadCatalog = Effect.gen(function* () {
  const version = yield* decodeVersion('1.0.0')
  const workflows = [{ inputs: [], name: 'Demo', versions: [version], workflowId: 'demo' }]
  return { workflows }
})

live('serializes domain SemVer catalog values as HTTP strings', () =>
  Effect.gen(function* () {
    const request = yield* openApi({ ...unavailableWorkflows, listWorkflows: () => loadCatalog })
    const response = yield* request(catalogPath)
    expect(response.status).toBe(httpOk)
    expect(yield* responseJson(response)).toStrictEqual({
      workflows: [{ inputs: [], name: 'Demo', versions: ['1.0.0'], workflowId: 'demo' }],
    })
  }),
)

live.each([
  '00000000-0000-4000-8000-000000000001',
  'not-a-run-id',
  'event_00000000-0000-4000-8000-000000000001',
  'run_01890f2e-7b55-7cc1-8c5a-000000000001',
])('rejects malformed run ID %s before calling the workflow service', (id) =>
  Effect.gen(function* () {
    const getRunDetail = vi.fn<Workflows['Service']['getRunDetail']>(unavailable)
    const resumeRun = vi.fn<Workflows['Service']['resumeRun']>(unavailable)
    const request = yield* openApi({ ...unavailableWorkflows, getRunDetail, resumeRun })
    const read = yield* request(`${runsPath}/${id}`)
    const resume = yield* request(`${runsPath}/${id}/resume`, post)
    expect([read.status, resume.status]).toStrictEqual([httpBadRequest, httpBadRequest])
    expect(getRunDetail).not.toHaveBeenCalled()
    expect(resumeRun).not.toHaveBeenCalled()
  }),
)

const requests: Readonly<{ init?: RequestInit; method: string; path: string }[]> = [
  { method: 'GET', path: catalogPath },
  { method: 'GET', path: runsPath },
  { method: 'GET', path: runPath },
  { init: createRequest, method: 'POST', path: runsPath },
  { init: post, method: 'POST', path: resumePath },
]

// These promises come from the native RPC target before Effect can translate them.
// oxlint-disable-next-line typescript/require-await -- The real SDK observes a rejected native Promise from the transport.
const reject = async (): Promise<never> => {
  // oxlint-disable-next-line rules/require-tagged-error -- Model a native transport rejection without an application tag.
  throw new Error('Service binding disconnected')
}

const disconnected = makeRpcStub<Workflows['Service']>({
  createRun: reject,
  getRunDetail: reject,
  listRuns: reject,
  listWorkflows: reject,
  resumeRun: reject,
})

live.each(requests)('returns 502 for $method $path when native RPC transport rejects', ({ init, path }) =>
  Effect.gen(function* () {
    const request = yield* openApi(disconnected)
    const response = yield* request(path, init)
    expect(response.status).toBe(httpBadGateway)
    expect(yield* responseJson(response)).toMatchObject({ error: 'ExternalError' })
  }),
)

live.each(requests)('returns 502 for $method $path when the aggregate worker is unavailable', ({ init, path }) =>
  Effect.gen(function* () {
    const request = yield* openApi(unavailableWorkflows)
    const response = yield* request(path, init)
    expect(response.status).toBe(httpBadGateway)
    expect(yield* responseJson(response)).toMatchObject({ error: 'ExternalError' })
  }),
)

live.each([
  { init: { body: createBody, headers: textOrigin, method: 'POST' }, path: runsPath },
  { init: { body: 'not JSON', headers: textOrigin, method: 'POST' }, path: runsPath },
  { init: { headers: textOrigin, method: 'POST' }, path: resumePath },
])('rejects browser-originated POST $path before calling Workflows', ({ init, path }) =>
  Effect.gen(function* () {
    const createRun = vi.fn<Workflows['Service']['createRun']>(unavailable)
    const resumeRun = vi.fn<Workflows['Service']['resumeRun']>(unavailable)
    const request = yield* openApi({ ...unavailableWorkflows, createRun, resumeRun })
    const response = yield* request(path, init)
    expect(response.status).toBe(httpForbidden)
    expect(yield* responseJson(response)).toStrictEqual({
      error: 'Forbidden',
      message: 'Browser-originated control mutations are not allowed',
    })
    expect(createRun).not.toHaveBeenCalled()
    expect(resumeRun).not.toHaveBeenCalled()
  }),
)
