import { live } from '@effect/vitest'
import { Array, DateTime, Effect, SemVer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, vi } from 'vite-plus/test'

import { ControlError, makeControlApi } from './control-api.ts'

/** Transport fixtures exercise the real Effect client and schema boundary, not dashboard data. */
const clientReturning = (body: unknown, status = 200): HttpClient.HttpClient =>
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
  live('decodes valid prefixed run identities and named graph identities', () =>
    Effect.gen(function* () {
      const api = yield* makeControlApi.pipe(
        Effect.provideService(HttpClient.HttpClient, clientReturning({ runs: [run] })),
      )
      const value = yield* api.runs
      const decoded = Array.getUnsafe(value.runs, 0)
      expect(SemVer.isSemVer(decoded.workflowVersion)).toBe(true)
      expect(DateTime.isUtc(decoded.createdAt)).toBe(true)
      expect(DateTime.isUtc(decoded.updatedAt)).toBe(true)
      expect({
        ...decoded,
        workflowVersion: SemVer.format(decoded.workflowVersion),
        createdAt: DateTime.formatIso(decoded.createdAt),
        updatedAt: DateTime.formatIso(decoded.updatedAt),
      }).toStrictEqual(run)
    }),
  )

  live.each([
    { runId: '00000000-0000-4000-8000-000000000001' },
    { runId: 'event_00000000-0000-4000-8000-000000000001' },
    { runId: 'run_01890f2e-7b55-7cc1-8c5a-000000000001' },
    { workflowVersion: 'v1' },
    { graphId: 'demo:1.0.0:graph:1' },
  ])('rejects malformed run response %j at the API boundary', (invalid) =>
    Effect.gen(function* () {
      const api = yield* makeControlApi.pipe(
        Effect.provideService(HttpClient.HttpClient, clientReturning({ runs: [{ ...run, ...invalid }] })),
      )
      const error = yield* api.runs.pipe(Effect.flip)
      expect(error).toBeInstanceOf(ControlError)
    }),
  )

  live('decodes workflow responses through the supplied Effect HttpClient', () =>
    Effect.gen(function* () {
      const api = yield* makeControlApi.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientReturning({
            workflows: [{ workflowId: 'review', name: 'Review', versions: ['1.0.0', '2.0.0'], inputs: [] }],
          }),
        ),
      )
      const value = yield* api.workflows
      expect(Array.map(Array.getUnsafe(value.workflows, 0).versions, SemVer.format)).toStrictEqual(['1.0.0', '2.0.0'])
    }),
  )

  live('does not pass malformed control responses to the dashboard', () =>
    Effect.gen(function* () {
      const api = yield* makeControlApi.pipe(
        Effect.provideService(HttpClient.HttpClient, clientReturning({ runs: [{ runId: 17 }] })),
      )
      const error = yield* api.runs.pipe(Effect.flip)
      expect(error).toBeInstanceOf(ControlError)
    }),
  )

  live('turns unavailable control responses into a recoverable error', () =>
    Effect.gen(function* () {
      const api = yield* makeControlApi.pipe(
        Effect.provideService(HttpClient.HttpClient, clientReturning({ error: 'unavailable' }, 503)),
      )
      const message = yield* api.workflows.pipe(
        Effect.match({ onFailure: (error) => error.message, onSuccess: () => '' }),
      )
      expect(message).toContain('control plane')
    }),
  )
  live('returns a typed failure before sending an invalid start request', () =>
    Effect.gen(function* () {
      const respond = vi.fn(() => Effect.die('Invalid input must never reach transport'))
      const api = yield* makeControlApi.pipe(Effect.provideService(HttpClient.HttpClient, HttpClient.make(respond)))
      const input = { version: SemVer.parseUnsafe('1.0.0'), workflowId: '../invalid' }
      const error = yield* api.start(input).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ControlError)
      expect(respond).not.toHaveBeenCalled()
    }),
  )
})
