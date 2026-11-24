// oxlint-disable-next-line rules/no-node-imports -- Vite's Node bundler requires decoded filesystem paths.
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { virtualEntryPlugin } from 'alchemy/Bundle'
import { makeEffectVirtualEntry } from 'alchemy/Cloudflare/Workers/Sources/Rolldown'
import { Array, Context, Data, Effect, Option, Predicate } from 'effect'
import { build } from 'vite-plus'
import type { PluginOption } from 'vite-plus'

import { workspaceProxyBuild } from '@/core/worker/pi/feature/workspace-proxy-build'

class MissingSdkBundle extends Data.TaggedError('MissingSdkBundle')<{ message: string }> {}

const workerId = 'sdk-boundary'
const entryFile = fileURLToPath(new URL('development-sdk-worker.ts', import.meta.url))
const outDir = fileURLToPath(new URL('../../tmp/development-sdk-build', import.meta.url))
const virtual = makeEffectVirtualEntry(
  {
    SdkBoundary: {
      constructor: Effect.succeed(Effect.succeed({})),
      kind: 'durableObject',
      services: Context.empty(),
    },
  },
  { name: workerId, stage: 'test' },
)

const compile = async (plugins: PluginOption[]): ReturnType<typeof build> =>
  build({
    build: {
      lib: { entry: entryFile, formats: ['es'] },
      minify: false,
      outDir,
      rolldownOptions: { external: (id) => id.startsWith('cloudflare:') || id.startsWith('node:') },
      target: 'esnext',
      write: false,
    },
    configFile: false,
    logLevel: 'silent',
    plugins,
    resolve: { tsconfigPaths: true },
  })

const modulesFrom = Effect.fn('flowdeck.test.readSdkBundle')(function* (result: Awaited<ReturnType<typeof compile>>) {
  const output = Array.isArray(result) ? Option.getOrUndefined(Array.head(result)) : result
  if (Predicate.isNullish(output) || !('output' in output)) {
    return yield* new MissingSdkBundle({ message: 'Expected bundled SDK fixture' })
  }
  const chunks = Array.filter(output.output, (entry) => entry.type === 'chunk')
  const entryChunk = Array.findFirst(chunks, (entry) => entry.isEntry)
  if (Option.isNone(entryChunk)) {
    return yield* new MissingSdkBundle({ message: 'Expected SDK fixture entry chunk' })
  }
  const root = entryChunk.value
  const order = Array.prepend(
    Array.filter(chunks, (entry) => entry !== root),
    root,
  )
  return {
    exports: root.exports,
    modules: Array.map(order, (entry) => ({ contents: entry.code, path: entry.fileName, type: 'ESModule' as const })),
  }
})

export const bundleDevelopmentSdk = Effect.gen(function* () {
  const virtualEntry = yield* virtualEntryPlugin
  const plugins = [workspaceProxyBuild(), workspaceProxyBuild(), virtualEntry(virtual)]
  const result = yield* Effect.promise(async () => compile(plugins))
  return yield* modulesFrom(result)
}).pipe(Effect.provide(NodeServices.layer))
