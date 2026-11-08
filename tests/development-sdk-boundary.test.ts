import { fileURLToPath } from 'node:url'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { virtualEntryPlugin } from 'alchemy/Bundle'
import { makeEffectVirtualEntry } from 'alchemy/Cloudflare/Workers/Sources/Rolldown'
import { Array, Context, Effect, Schedule } from 'effect'
import { Miniflare } from 'miniflare'
import { build } from 'vite-plus'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { workspaceProxyBuild } from '@/workers/development-workflow/features/workspace-proxy-build'

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

describe('Alchemy Effect DO and official native SDK raw boundary', () => {
  let miniflare: Miniflare

  beforeAll(async () => {
    const virtualEntry = await Effect.runPromise(virtualEntryPlugin.pipe(Effect.provide(NodeServices.layer)))
    const result = await build({
      configFile: false,
      resolve: { tsconfigPaths: true },
      logLevel: 'silent',
      plugins: [
        workspaceProxyBuild(),
        workspaceProxyBuild(),
        virtualEntry(
          makeEffectVirtualEntry(
            {
              SdkBoundary: {
                kind: 'durableObject',
                services: Context.empty(),
                constructor: Effect.succeed(Effect.succeed({})),
              },
            },
            { name: 'sdk-boundary', stage: 'test' },
          ),
        ),
      ],
      build: {
        target: 'esnext',
        write: false,
        minify: false,
        outDir: fileURLToPath(new URL('../tmp/development-sdk-build', import.meta.url)),
        lib: {
          entry: fileURLToPath(new URL('./fixtures/development-sdk-worker.ts', import.meta.url)),
          formats: ['es'],
        },
        rolldownOptions: { external: (id) => id.startsWith('cloudflare:') || id.startsWith('node:') },
      },
    })
    const output = Array.isArray(result) ? result[0] : result
    if (!output || !('output' in output)) throw new Error('Expected bundled SDK fixture')
    const chunks = Array.filter(output.output, (entry) => entry.type === 'chunk')
    const chunk = Array.findFirst(chunks, (entry) => entry.isEntry)
    if (chunk._tag === 'None') throw new Error('Expected SDK fixture entry chunk')
    expect(chunk.value.exports).toEqual(expect.arrayContaining(['SdkBoundary', 'WorkspaceProxy', 'default']))
    miniflare = new Miniflare({
      workers: [
        {
          name: 'caller',
          modules: true,
          script: caller,
          compatibilityDate: '2026-07-30',
          durableObjects: { PROBE: { className: 'SdkBoundary', scriptName: 'effect', useSQLite: true } },
        },
        {
          name: 'effect',
          outboundService: () => {
            throw new Error('External network access is forbidden in this test')
          },
          modules: Array.map(
            Array.prepend(
              Array.filter(chunks, (entry) => entry !== chunk.value),
              chunk.value,
            ),
            (entry) => ({ type: 'ESModule' as const, path: entry.fileName, contents: entry.code }),
          ),
          compatibilityDate: '2026-07-30',
          compatibilityFlags: ['nodejs_compat'],
          bindings: {
            CLOUDFLARE_ACCOUNT_ID: 'test-account',
            CLOUDFLARE_AI_GATEWAY_ID: 'test-gateway',
            CLOUDFLARE_AI_GATEWAY_API_KEY: 'test-key-not-sent',
          },
          durableObjects: { PROBE: { className: 'SdkBoundary', useSQLite: true } },
        },
      ],
    })
  }, 60_000)

  afterAll(async () => {
    await miniflare?.dispose()
  })

  const read = async (path = '/') => {
    const response = await miniflare.dispatchFetch(`https://probe${path}`)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }

  it('starts the production PiHarness in an Effect DO with SQLite and no external I/O', async () => {
    expect(await read()).toEqual({ jobs: 0, sqlite: 1 })
    expect(await read('/fetch')).toEqual({ jobs: 0 })
  })

  it('does not mistake the SDK Capnweb target for a native Cloudflare RPC capability', async () => {
    expect(await read('/capnweb')).toEqual({
      accepted: false,
      name: 'DataCloneError',
      message: expect.stringContaining('WorkspaceStub'),
    })
  })

  it('retains WorkspaceProxy in the generated Effect bundle even when the plugin is registered twice', async () => {
    expect(await read('/proxy')).toEqual({ status: 200, text: 'ok\n' })
  })

  it('forwards a real workerd alarm to the official Lifecycle job queue', async () => {
    expect(await read('/schedule')).toEqual({ queued: 1 })
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        expect(await read()).toEqual({ jobs: 0, sqlite: 1 })
      }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced('20 millis') })),
    )
  })
})
