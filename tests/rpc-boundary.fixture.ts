// oxlint-disable-next-line rules/no-node-imports -- Vite needs decoded native filesystem paths to bundle the fixture in Node.
import { fileURLToPath } from 'node:url'

import { Array, Data, Effect, Option, Predicate } from 'effect'
import type { Scope } from 'effect'
import { Miniflare } from 'miniflare'
import { build } from 'vite-plus'

import type Parent from './fixtures/rpc-boundary-worker.ts'

class MissingWorkerBundle extends Data.TaggedError('MissingWorkerBundle')<{ message: string }> {}

export const compileRpcBoundary = async (): Promise<string> => {
  const compiled = await build({
    build: {
      lib: {
        entry: fileURLToPath(new URL('fixtures/rpc-boundary-worker.ts', import.meta.url)),
        fileName: 'rpc-boundary-worker',
        formats: ['es'],
      },
      minify: false,
      outDir: fileURLToPath(new URL('../tmp/rpc-boundary-build', import.meta.url)),
      rolldownOptions: { external: ['cloudflare:workers'] },
      target: 'esnext',
      write: false,
    },
    configFile: false,
    logLevel: 'silent',
    resolve: { tsconfigPaths: true },
  })
  const output = Array.isArray(compiled) ? Option.getOrUndefined(Array.head(compiled)) : compiled
  if (Predicate.isNullish(output) || !('output' in output)) {
    throw new MissingWorkerBundle({ message: 'Vite did not return the Workerd fixture bundle.' })
  }
  const chunk = Array.findFirst(output.output, (artifact) => artifact.type === 'chunk')
  if (Option.isNone(chunk)) {
    throw new MissingWorkerBundle({ message: 'The Workerd fixture bundle has no executable chunk.' })
  }
  return chunk.value.code
}

type RpcBinding = Pick<Service<Parent>, 'logs' | 'start'>
type WorkerName = 'child' | 'parent'
const compatibilityDate = '2026-07-30'

const remote = (miniflare: Miniflare, name: WorkerName): Effect.Effect<RpcBinding> =>
  Effect.promise(async () => {
    const worker = await miniflare.getWorker(name)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types native service entrypoints as Fetcher. The bundled Worker defines this RPC surface.
    return worker as unknown as RpcBinding
  })

const openWorker = (script: string): Effect.Effect<Miniflare, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare({
          workers: [
            {
              compatibilityDate,
              modules: true,
              name: 'parent',
              script,
              serviceBindings: { CHILD: { entrypoint: 'Child', name: 'child' } },
            },
            { compatibilityDate, modules: true, name: 'child', script },
          ],
        }),
    ),
    (miniflare) => Effect.promise(async () => miniflare.dispose()),
  )

export const openRpcBoundary = Effect.fn('flowdeck.test.openRpcBoundary')(function* (script: string) {
  const worker = yield* openWorker(script)
  const parent = yield* remote(worker, 'parent')
  const child = yield* remote(worker, 'child')
  return { child, parent }
})
