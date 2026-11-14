import { fileURLToPath } from 'node:url'

import { Array } from 'effect'
import { Miniflare } from 'miniflare'
import { build } from 'vite-plus'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

describe('official DO-only Pi workspace', () => {
  let miniflare: Miniflare

  beforeAll(async () => {
    const result = await build({
      configFile: false,
      resolve: { tsconfigPaths: true },
      logLevel: 'silent',
      build: {
        target: 'esnext',
        write: false,
        outDir: fileURLToPath(new URL('../../../../tmp/worker-shell-build', import.meta.url)),
        lib: { entry: fileURLToPath(new URL('./worker-shell.fixture.ts', import.meta.url)), formats: ['es'] },
        rolldownOptions: { external: (id) => id.startsWith('cloudflare:') || id.startsWith('node:') },
      },
    })
    const output = Array.isArray(result) ? result[0] : result
    if (!output || !('output' in output)) throw new Error('Expected Worker-shell fixture bundle')
    const chunks = Array.filter(output.output, (entry) => entry.type === 'chunk')
    const main = Array.findFirst(chunks, (entry) => entry.isEntry)
    if (main._tag === 'None') throw new Error('Expected Worker-shell fixture entry')
    miniflare = new Miniflare({
      modules: Array.map(
        Array.prepend(
          Array.filter(chunks, (entry) => entry !== main.value),
          main.value,
        ),
        (entry) => ({ type: 'ESModule' as const, path: entry.fileName, contents: entry.code }),
      ),
      compatibilityDate: '2026-07-30',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { PROBE: { className: 'DevelopmentRun', useSQLite: true } },
      // No Container, Loader, Gateway credentials or inference endpoint exists.
      outboundService: () => {
        throw new Error('Unexpected external network access')
      },
    })
  }, 60_000)

  afterAll(async () => {
    await miniflare?.dispose()
  })

  const read = async (path: string) => {
    const response = await miniflare.dispatchFetch(`https://workspace${path}`)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }

  it('initializes the real PiHarness without Container or Gateway provisioning', async () => {
    expect(await read('/sdk')).toEqual({ jobs: 0, fetchStatus: 404 })
    expect(await read('/sdk')).toEqual({ jobs: 0, fetchStatus: 404 })
  })

  it('reaches durable files through the outer Alchemy PiRun bridge after the previous Scope closes', async () => {
    expect(await read('/write')).toEqual({ written: true })
    expect(await read('/read')).toEqual({ text: 'durable workspace' })
    expect(await read('/exec')).toMatchObject({ exitCode: 0, stdout: 'durable workspace', stderr: '' })
    expect(await read('/read')).toEqual({ text: 'durable workspace' })
  })

  it('does not claim Node process support from the DO-local shell', async () => {
    expect(await read('/unsupported')).toMatchObject({
      exitCode: 127,
      stdout: '',
      stderr: expect.stringContaining('node'),
    })
  })
})
