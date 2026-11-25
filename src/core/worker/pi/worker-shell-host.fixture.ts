// oxlint-disable-next-line rules/no-node-imports -- Vite requires a decoded native path for this filesystem fixture entry.
import { fileURLToPath } from 'node:url'

import { Array, Context, Data, Effect, Layer, Option, Predicate } from 'effect'
import { Miniflare } from 'miniflare'
import { build } from 'vite-plus'

const WorkerShellFixtureError = Data.TaggedError('WorkerShellFixtureError')<{ message: string }>

const entryFile = fileURLToPath(new URL('worker-shell.fixture.ts', import.meta.url))
const outDir = fileURLToPath(new URL('../../../../tmp/worker-shell-build', import.meta.url))
const httpOk = 200

const compileShellWorker = async (): ReturnType<typeof build> =>
  build({
    build: {
      lib: { entry: entryFile, formats: ['es'] },
      outDir,
      rolldownOptions: { external: (id) => id.startsWith('cloudflare:') || id.startsWith('node:') },
      target: 'esnext',
      write: false,
    },
    configFile: false,
    logLevel: 'silent',
    resolve: { tsconfigPaths: true },
  })

type Modules = { contents: string; path: string; type: 'ESModule' }[]
const findModules = (result: Awaited<ReturnType<typeof compileShellWorker>>): Modules => {
  const output = Array.isArray(result) ? Option.getOrUndefined(Array.head(result)) : result
  if (Predicate.isNullish(output) || !('output' in output)) {
    throw new WorkerShellFixtureError({ message: 'Expected Worker-shell fixture bundle' })
  }
  const chunks = Array.filter(output.output, (entry) => entry.type === 'chunk')
  const root = Array.findFirst(chunks, (entry) => entry.isEntry)
  const main = Option.getOrThrowWith(
    root,
    () => new WorkerShellFixtureError({ message: 'Expected Worker-shell fixture entry' }),
  )
  const ordered = Array.prepend(
    Array.filter(chunks, (entry) => entry !== main),
    main,
  )
  return Array.map(ordered, ({ code, fileName }) => ({ contents: code, path: fileName, type: 'ESModule' }))
}

const openShellHost = Effect.gen(function* () {
  const compiled = yield* Effect.promise(compileShellWorker)
  const modules = findModules(compiled)
  const host = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare({
          compatibilityDate: '2026-07-30',
          compatibilityFlags: ['nodejs_compat'],
          durableObjects: { PROBE: { className: 'DevelopmentRun', useSQLite: true } },
          modules,
          outboundService: () => {
            throw new WorkerShellFixtureError({ message: 'Unexpected external network access' })
          },
        }),
    ),
    (owner) => Effect.promise(async () => owner.dispose()),
  )
  const read = Effect.fn('flowdeck.test.readWorkerShellHost')(function* (path: string) {
    const response = yield* Effect.promise(async () => host.dispatchFetch(`https://workspace${path}`))
    if (response.status !== httpOk) {
      const body = yield* Effect.promise(async () => response.text())
      return yield* new WorkerShellFixtureError({ message: `Unexpected HTTP ${response.status}: ${body}` })
    }
    const result: unknown = yield* Effect.promise(async () => response.json())
    return result
  })
  return { read }
})

export class WorkerShellHost extends Context.Service<WorkerShellHost, Effect.Success<typeof openShellHost>>()(
  'flowdeck/test/WorkerShellHost',
) {
  public static layer = Layer.effect(this, openShellHost)
}
