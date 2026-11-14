import { createModels } from '@earendil-works/pi-ai'
import { makeDurableObjectBridge } from 'alchemy/Cloudflare/Bridge'
import { Request } from 'alchemy/Cloudflare/Workers'
import { makeWorkerRuntimeContext } from 'alchemy/Cloudflare/Workers/WorkerRuntimeContext'
import { DurableObject } from 'cloudflare:workers'
import { Context, Effect } from 'effect'
import { HttpServerResponse } from 'effect/http'

import { Store } from '@/core/feature/workflow/services/store'

import { makeWorkerShellWorkspace } from './feature/worker-shell'
import { makeWorkerShellPiSdk } from './worker-shell-runtime'

const unexpected = Effect.die(new Error('Unexpected workflow persistence access'))
const store = Store.of({
  create: () => unexpected,
  listRuns: unexpected,
  getRun: () => unexpected,
  getGraph: () => unexpected,
  getEvents: () => unexpected,
  commit: () => unexpected,
})
const runtime = makeWorkerRuntimeContext('WorkerShellProbe')

const handle = (request: globalThis.Request) =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname
    if (path === '/sdk') {
      const sdk = yield* makeWorkerShellPiSdk({
        models: createModels(),
        model: { id: 'test-no-inference', provider: 'test' },
      })
      yield* Effect.promise(() => sdk.lifecycle.start())
      const response = yield* sdk.fetch(request)
      return Response.json({ jobs: sdk.lifecycle.jobs.list().length, fetchStatus: response.status })
    }
    const { workspace } = yield* makeWorkerShellWorkspace
    if (path === '/write') {
      yield* Effect.promise(() => workspace.fs.writeFile('/persist.txt', 'durable workspace'))
      return Response.json({ written: true })
    }
    if (path === '/read') {
      return Response.json({ text: yield* Effect.promise(() => workspace.fs.readFile('/persist.txt', 'utf8')) })
    }
    const exec = yield* Effect.acquireRelease(
      Effect.promise(() =>
        workspace.runtime.exec(path === '/unsupported' ? 'node --version' : 'cat /persist.txt', { encoding: 'utf8' }),
      ),
      (execution) => Effect.sync(() => execution[Symbol.dispose]()),
    )
    return Response.json(yield* Effect.promise(() => exec.result()))
  })

/** Alchemy's real outer bridge supplies the native state used by the production
 * backend. Nothing exports a Capnweb stub across Workers RPC or fakes a DO host. */
export const entrypoint = Effect.gen(function* () {
  yield* runtime.export('DevelopmentRun', {
    kind: 'durableObject',
    services: Context.empty(),
    constructor: Effect.succeed(
      Effect.succeed({
        fetch: Request.pipe(
          Effect.flatMap(handle),
          Effect.map(HttpServerResponse.fromWeb),
          Effect.provideService(Store, store),
          Effect.scoped,
        ),
      }),
    ),
  })
  return { RuntimeContext: runtime }
})

// Use the existing PiRun native binding identity with the same official bridge
// construction used by its generated Alchemy entry, without provisioning infra.
export const DevelopmentRun = makeDurableObjectBridge(DurableObject, {
  entrypoint,
  stack: { name: 'worker-shell-boundary', stage: 'test' },
})('DevelopmentRun')

export default {
  fetch(request: globalThis.Request, env: { PROBE: DurableObjectNamespace }) {
    return env.PROBE.get(env.PROBE.idFromName('workspace')).fetch(request)
  },
}
