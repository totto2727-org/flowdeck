import { Array, DateTime, Effect, SemVer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from 'vite-plus/test'

import { makeControlApi } from './control-api'

/** Transport fixtures exercise the real Effect client and schema boundary, not dashboard data. */
const clientReturning = (body: unknown, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))))

const run = {
  runId: 'run_00000000-0000-4000-8000-000000000001',
  workflowId: 'demo',
  workflowVersion: '1.0.0',
  graphId: 'demo-1_0_0-graph-1',
  status: 'waiting',
  revision: 1,
  snapshot: {},
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
}

describe('ControlApi', () => {
  it('decodes valid prefixed run identities and named graph identities', async () => {
    const api = await Effect.runPromise(
      makeControlApi.pipe(Effect.provideService(HttpClient.HttpClient, clientReturning({ runs: [run] }))),
    )
    const value = await Effect.runPromise(api.runs)
    const decoded = Array.getUnsafe(value.runs, 0)
    expect(SemVer.isSemVer(decoded.workflowVersion)).toBe(true)
    expect(DateTime.isUtc(decoded.createdAt)).toBe(true)
    expect(DateTime.isUtc(decoded.updatedAt)).toBe(true)
    expect({
      ...decoded,
      workflowVersion: SemVer.format(decoded.workflowVersion),
      createdAt: DateTime.formatIso(decoded.createdAt),
      updatedAt: DateTime.formatIso(decoded.updatedAt),
    }).toEqual(run)
  })

  it.each([
    { runId: '00000000-0000-4000-8000-000000000001' },
    { runId: 'event_00000000-0000-4000-8000-000000000001' },
    { runId: 'run_01890f2e-7b55-7cc1-8c5a-000000000001' },
    { workflowVersion: 'v1' },
    { graphId: 'demo:1.0.0:graph:1' },
  ])('rejects malformed run response %j at the API boundary', async (invalid) => {
    const api = await Effect.runPromise(
      makeControlApi.pipe(
        Effect.provideService(HttpClient.HttpClient, clientReturning({ runs: [{ ...run, ...invalid }] })),
      ),
    )
    expect((await Effect.runPromise(api.runs.pipe(Effect.result)))._tag).toBe('Failure')
  })

  it('decodes workflow responses through the supplied Effect HttpClient', async () => {
    const api = await Effect.runPromise(
      makeControlApi.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientReturning({
            workflows: [{ workflowId: 'review', name: 'Review', versions: ['1.0.0', '2.0.0'], inputs: [] }],
          }),
        ),
      ),
    )
    const value = await Effect.runPromise(api.workflows)
    expect(Array.map(Array.getUnsafe(value.workflows, 0).versions, SemVer.format)).toEqual(['1.0.0', '2.0.0'])
  })

  it('does not pass malformed control responses to the dashboard', async () => {
    const api = await Effect.runPromise(
      makeControlApi.pipe(Effect.provideService(HttpClient.HttpClient, clientReturning({ runs: [{ runId: 17 }] }))),
    )
    const value = await Effect.runPromise(api.runs.pipe(Effect.result))
    expect(value._tag).toBe('Failure')
  })

  it('turns unavailable control responses into a recoverable error', async () => {
    const api = await Effect.runPromise(
      makeControlApi.pipe(Effect.provideService(HttpClient.HttpClient, clientReturning({ error: 'unavailable' }, 503))),
    )
    const message = await Effect.runPromise(
      api.workflows.pipe(Effect.match({ onSuccess: () => '', onFailure: (error) => error.message })),
    )
    expect(message).toContain('control plane')
  })
})
