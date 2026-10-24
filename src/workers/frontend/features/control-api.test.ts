import { Array, Effect } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from 'vite-plus/test'

import { makeControlApi } from './control-api'

/** Transport fixtures exercise the real Effect client and schema boundary, not dashboard data. */
const clientReturning = (body: unknown, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))))

describe('ControlApi', () => {
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
    expect(Array.getUnsafe(value.workflows, 0).versions).toEqual(['1.0.0', '2.0.0'])
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
