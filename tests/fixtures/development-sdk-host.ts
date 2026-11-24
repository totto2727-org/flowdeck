import { Data, Effect } from 'effect'
import { Miniflare } from 'miniflare'

import { bundleDevelopmentSdk } from './development-sdk-bundle.ts'

const caller = `export default { async fetch(request, env) {
  const stub = env.PROBE.getByName('test')
  const path = new URL(request.url).pathname
  if (path === '/capnweb') {
    try { await stub.capnwebTarget(); return Response.json({ accepted: true }) }
    catch (error) { return Response.json({ accepted: false, name: error.name, message: error.message }) }
  }
  if (path === '/proxy') return Response.json(await stub.proxyHealth())
  if (path === '/schedule') return Response.json(await stub.schedule())
  if (path === '/fetch') return stub.fetch('https://probe/')
  return Response.json(await stub.inspect())
} }`

const compatibilityDate = '2026-07-30'
const className = 'SdkBoundary'
const effectWorker = 'effect'
const expectedStatus = 200

const ExternalIo = Data.TaggedError('ExternalIo')<{ message: string }>
class BadSdkResponse extends Data.TaggedError('BadSdkResponse')<{ body: string; status: number }> {}

const openWorker = (modules: Effect.Success<typeof bundleDevelopmentSdk>['modules']): Miniflare =>
  new Miniflare({
    workers: [
      {
        compatibilityDate,
        durableObjects: { PROBE: { className, scriptName: effectWorker, useSQLite: true } },
        modules: true,
        name: 'caller',
        script: caller,
      },
      {
        bindings: {
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
          CLOUDFLARE_AI_GATEWAY_API_KEY: 'test-key-not-sent',
          CLOUDFLARE_AI_GATEWAY_ID: 'test-gateway',
        },
        compatibilityDate,
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { PROBE: { className, useSQLite: true } },
        modules,
        name: effectWorker,
        outboundService: () => {
          throw new ExternalIo({ message: 'External network access is forbidden in this test' })
        },
      },
    ],
  })

export const openDevelopmentSdk = Effect.gen(function* () {
  const { exports, modules } = yield* bundleDevelopmentSdk
  const host = yield* Effect.acquireRelease(
    Effect.sync(() => openWorker(modules)),
    (worker) => Effect.promise(async () => worker.dispose()),
  )
  const read = Effect.fn('flowdeck.test.dispatchNativeSdk')(function* (path = '/') {
    const response = yield* Effect.promise(async () => host.dispatchFetch(`https://probe${path}`))
    if (response.status !== expectedStatus) {
      const body = yield* Effect.promise(async () => response.text())
      return yield* new BadSdkResponse({ body, status: response.status })
    }
    const parsed: unknown = yield* Effect.promise(async () => response.json())
    return parsed
  })
  return { exports, read }
})
