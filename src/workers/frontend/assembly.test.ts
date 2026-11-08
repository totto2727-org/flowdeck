import {
  WorkerEnvironment,
  WorkerExecutionContext,
  type WorkerExecutionContextAccess,
} from 'alchemy/Cloudflare/Workers'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, Layer, Schema } from 'effect'
import { HttpEffect } from 'effect/http'
import { describe, expect, it, vi } from 'vite-plus/test'

import { frontendRequest, FrontendRequestLayer } from './assembly'
import { ControlApi } from './features/control-api'

/** Only the platform admission is substituted. The real request Layer and HTTP adapter run below. */
const host = (environment: Record<string, unknown>, admission: WorkerExecutionContextAccess | undefined) =>
  Layer.mergeAll(
    Layer.succeed(WorkerEnvironment, environment),
    Layer.succeed(WorkerExecutionContext, {
      access: Effect.succeed(admission),
      waitUntil: () => Effect.void,
      passThroughOnException: () => Effect.void,
      get raw(): WorkerExecutionContext['Service']['raw'] {
        throw new Error('Native execution context must not be used by request assembly')
      },
      get cache(): WorkerExecutionContext['Service']['cache'] {
        throw new Error('Native cache must not be used by request assembly')
      },
    }),
    Layer.mock(RuntimeContext, { Type: 'test', id: 'frontend-request', env: {} }),
  )
const admitted = (aud = 'flowdeck-audience'): WorkerExecutionContextAccess => ({
  aud,
  getIdentity: () => Effect.die('Trusted admission must not trigger an identity lookup'),
})
const completeLayer = (environment: Record<string, unknown>, admission: WorkerExecutionContextAccess | undefined) =>
  FrontendRequestLayer.pipe(Layer.provideMerge(host(environment, admission)))

const catalog = (name: string) => ({
  workflows: [{ workflowId: 'demo', name, versions: ['1.0.0'], inputs: [] }],
})

describe('frontend request composition', () => {
  it.each([
    [{}, admitted(), 503, 'Access is not configured.'],
    [{ FLOWDECK_ACCESS_AUD: '' }, admitted(), 503, 'Access is not configured.'],
    [{ FLOWDECK_ACCESS_AUD: 'flowdeck-audience' }, undefined, 401, 'Cloudflare Access authentication is required.'],
    [
      { FLOWDECK_ACCESS_AUD: 'flowdeck-audience' },
      admitted('another-application'),
      403,
      'This Access application is not authorized.',
    ],
  ] as const)(
    'returns the fail-closed response before resolving an invalid Control binding: %j',
    async (environment, admission, status, message) => {
      const control = vi.fn(() => {
        throw new Error('Denied requests must not inspect the Control binding')
      })
      const handler = HttpEffect.toWebHandler(
        frontendRequest.pipe(
          Effect.provide(
            completeLayer(
              {
                ...environment,
                get CONTROL() {
                  return control()
                },
              },
              admission,
            ),
          ),
        ),
      )
      const response = await handler(new Request('https://flowdeck.example/'))
      expect(response.status).toBe(status)
      expect(await response.text()).toBe(message)
      expect(control).not.toHaveBeenCalled()
    },
  )

  it('keeps independently constructed Control clients bound to their own request environment', async () => {
    const firstFetch = vi.fn(async () => Response.json(catalog('First request')))
    const secondFetch = vi.fn(async () => Response.json(catalog('Second request')))
    const firstApi = await Effect.runPromise(
      ControlApi.pipe(
        Effect.provide(
          completeLayer({ FLOWDECK_ACCESS_AUD: 'flowdeck-audience', CONTROL: { fetch: firstFetch } }, admitted()),
        ),
      ),
    )
    const secondApi = await Effect.runPromise(
      ControlApi.pipe(
        Effect.provide(
          completeLayer({ FLOWDECK_ACCESS_AUD: 'flowdeck-audience', CONTROL: { fetch: secondFetch } }, admitted()),
        ),
      ),
    )
    // Calls have no ambient HttpClient or WorkerEnvironment. Construction captured each capability.
    const [first, second, firstAgain] = await Effect.runPromise(
      Effect.all([firstApi.workflows, secondApi.workflows, firstApi.workflows], { concurrency: 'unbounded' }),
    )
    expect(first.workflows).toMatchObject([{ name: 'First request' }])
    expect(second.workflows).toMatchObject([{ name: 'Second request' }])
    expect(firstAgain).toEqual(first)
    expect(firstFetch).toHaveBeenCalledTimes(2)
    expect(secondFetch).toHaveBeenCalledTimes(1)
  })

  it('uses the native binding only at the HTTP adapter and preserves mutation method and JSON body', async () => {
    const seen: Array<{ method: string; url: string; body: unknown }> = []
    const fetch = vi.fn(async (request: Request) => {
      seen.push({ method: request.method, url: request.url, body: await request.json() })
      return Response.json({ error: 'unavailable' }, { status: 503 })
    })
    const api = await Effect.runPromise(
      ControlApi.pipe(
        Effect.provide(completeLayer({ FLOWDECK_ACCESS_AUD: 'flowdeck-audience', CONTROL: { fetch } }, admitted())),
      ),
    )
    // The real domain codec emits SemVer as a string before the adapter converts the request.
    const result = await Effect.runPromise(
      api
        .start({ workflowId: 'demo', version: Schema.decodeUnknownSync(Schema.SemVerFromString)('1.0.0') })
        .pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ControlError' } })
    expect(seen).toEqual([
      { method: 'POST', url: 'https://control.internal/api/runs', body: { workflowId: 'demo', version: '1.0.0' } },
    ])
  })
})
