import { live } from '@effect/vitest'
import { WorkerEnvironment, WorkerExecutionContext } from 'alchemy/Cloudflare/Workers'
import type { WorkerExecutionContextAccess } from 'alchemy/Cloudflare/Workers'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Data, Effect, Layer, Schema } from 'effect'
import { HttpEffect } from 'effect/http'
import { describe, expect, test, vi } from 'vite-plus/test'

import { ControlApi, ControlError } from '@/core/worker/frontend/feature/control-api'
import { HttpStatus } from '@/share/feature/http/status'

import { frontendRequest, FrontendRequestLayer } from './assembly.ts'
import type { ControlBinding } from './assembly.ts'

class UnexpectedPlatformRead extends Data.TaggedError('UnexpectedPlatformRead')<{ capability: string }> {}

const workerContext = (admission?: WorkerExecutionContextAccess): WorkerExecutionContext['Service'] => ({
  access: Effect.succeed(admission),
  get cache(): WorkerExecutionContext['Service']['cache'] {
    throw new UnexpectedPlatformRead({ capability: 'native cache' })
  },
  passThroughOnException: () => Effect.void,
  get raw(): WorkerExecutionContext['Service']['raw'] {
    throw new UnexpectedPlatformRead({ capability: 'native execution context' })
  },
  waitUntil: () => Effect.void,
})

const audience = 'flowdeck-audience'
const env = { FLOWDECK_ACCESS_AUD: audience }

const admitted = (aud = audience): WorkerExecutionContextAccess => ({
  aud,
  getIdentity: () => Effect.die('Trusted admission must not trigger an identity lookup'),
})

// Substitute only the platform admission. The real request layer runs the HTTP adapter.
const host = (
  environment: Record<string, unknown>,
  admission?: WorkerExecutionContextAccess,
): Layer.Layer<RuntimeContext | WorkerEnvironment | WorkerExecutionContext> =>
  Layer.mergeAll(
    Layer.succeed(WorkerEnvironment, environment),
    Layer.succeed(WorkerExecutionContext, workerContext(admission)),
    Layer.mock(RuntimeContext, { Type: 'test', env: {}, id: 'frontend-request' }),
  )

const completeLayer = (
  environment: Record<string, unknown>,
  admission?: WorkerExecutionContextAccess,
): Layer.Layer<
  Layer.Success<typeof FrontendRequestLayer> | RuntimeContext | WorkerEnvironment | WorkerExecutionContext
> => FrontendRequestLayer.pipe(Layer.provideMerge(host(environment, admission)))

const deniedCases = [
  {
    admission: admitted(),
    environment: {},
    message: 'Access is not configured.',
    status: HttpStatus.serviceUnavailable,
  },
  {
    admission: admitted(),
    environment: { FLOWDECK_ACCESS_AUD: '' },
    message: 'Access is not configured.',
    status: HttpStatus.serviceUnavailable,
  },
  {
    admission: undefined,
    environment: env,
    message: 'Cloudflare Access authentication is required.',
    status: HttpStatus.unauthorized,
  },
  {
    admission: admitted('another-application'),
    environment: env,
    message: 'This Access application is not authorized.',
    status: HttpStatus.forbidden,
  },
]

describe('frontend access admission', () => {
  test.each(deniedCases)(
    'returns $status before resolving an invalid Control binding',
    async ({ admission, environment, message, status }) => {
      const control = vi.fn<() => never>(() => {
        throw new UnexpectedPlatformRead({ capability: 'Control binding' })
      })
      const bindings = {
        ...environment,
        get CONTROL() {
          return control()
        },
      }
      const layer = completeLayer(bindings, admission)
      const operation = frontendRequest.pipe(Effect.provide(layer))
      const handler = HttpEffect.toWebHandler(operation)
      const response = await handler(new Request('https://flowdeck.example/'))
      expect(response.status).toBe(status)
      await expect(response.text()).resolves.toBe(message)
      expect(control).not.toHaveBeenCalled()
    },
  )
})

const requestApi = Effect.fn('flowdeck.test.constructRequestControlClient')(function* (binding: ControlBinding) {
  const layer = completeLayer({ ...env, CONTROL: binding }, admitted())
  return yield* ControlApi.pipe(Effect.provide(layer))
})

const workflowResponse = (name: string): Response =>
  Response.json({ workflows: [{ inputs: [], name, versions: ['1.0.0'], workflowId: 'demo' }] })

const respondWithCatalog =
  (name: string): ControlBinding['fetch'] =>
  // oxlint-disable-next-line typescript/promise-function-async -- The native binding resolves a fresh response for each call.
  () =>
    Promise.resolve(workflowResponse(name))

const parseVersion = Schema.decodeEffect(Schema.SemVerFromString)
interface RecordedRequest {
  body: unknown
  method: string
  url: string
}

describe('frontend native Control adapter', () => {
  live('keeps each independently constructed client bound to its request environment', () =>
    Effect.gen(function* () {
      const firstFetch = vi.fn<ControlBinding['fetch']>().mockImplementation(respondWithCatalog('First request'))
      const secondFetch = vi.fn<ControlBinding['fetch']>().mockImplementation(respondWithCatalog('Second request'))
      const firstApi = yield* requestApi({ fetch: firstFetch })
      const secondApi = yield* requestApi({ fetch: secondFetch })
      // Calls have no ambient HttpClient or WorkerEnvironment. Construction captured each binding.
      const [first, second, firstAgain] = yield* Effect.all(
        [firstApi.workflows, secondApi.workflows, firstApi.workflows],
        { concurrency: 'unbounded' },
      )
      expect(first.workflows).toMatchObject([{ name: 'First request' }])
      expect(second.workflows).toMatchObject([{ name: 'Second request' }])
      expect(firstAgain).toStrictEqual(first)
      expect(firstFetch).toHaveBeenCalledTimes(2)
      expect(secondFetch).toHaveBeenCalledOnce()
    }),
  )

  live('uses the native binding at the HTTP adapter and preserves the mutation method and JSON body', () =>
    Effect.gen(function* () {
      const seen: RecordedRequest[] = []
      const fetch = vi.fn<ControlBinding['fetch']>(async (request) => {
        const body: unknown = await request.json()
        seen.push({ body, method: request.method, url: request.url })
        return Response.json({ error: 'unavailable' }, { status: HttpStatus.serviceUnavailable })
      })
      const api = yield* requestApi({ fetch })
      const version = yield* parseVersion('1.0.0')
      const failure = yield* api.start({ version, workflowId: 'demo' }).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(ControlError)
      expect(seen).toStrictEqual([
        { body: { version: '1.0.0', workflowId: 'demo' }, method: 'POST', url: 'https://control.internal/api/runs' },
      ])
    }),
  )
})
