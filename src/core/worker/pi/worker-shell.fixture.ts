import { createModels } from '@earendil-works/pi-ai'
import { makeDurableObjectBridge } from 'alchemy/Cloudflare/Bridge'
import { Request } from 'alchemy/Cloudflare/Workers'
import { makeWorkerRuntimeContext } from 'alchemy/Cloudflare/Workers/WorkerRuntimeContext'
import { DurableObject } from 'cloudflare:workers'
import { Context, Effect } from 'effect'
import { HttpServerResponse } from 'effect/http'

import { Store } from '@/core/feature/workflow/services/store'

import { makeWorkerShellWorkspace } from './feature/worker-shell.ts'
import { makeWorkerShellPiSdk } from './worker-shell-runtime.ts'

const unexpected = Effect.die('Unexpected workflow persistence access')
const store = Store.of({
  commit: () => unexpected,
  create: () => unexpected,
  getEvents: () => unexpected,
  getGraph: () => unexpected,
  getRun: () => unexpected,
  listRuns: unexpected,
})
const runtime = makeWorkerRuntimeContext('WorkerShellProbe')
const persistedPath = '/persist.txt'
type WorkspaceClient = Effect.Success<typeof makeWorkerShellWorkspace>['workspace']

const sdkReadiness = Effect.fn('flowdeck.test.checkNativeShellSdk')(function* (request: globalThis.Request) {
  const sdk = yield* makeWorkerShellPiSdk({
    model: { id: 'test-no-inference', provider: 'test' },
    models: createModels(),
  })
  yield* Effect.promise(async () => sdk.lifecycle.start())
  const response = yield* sdk.fetch(request)
  return Response.json({ fetchStatus: response.status, jobs: sdk.lifecycle.jobs.list().length })
})

const shellResult = Effect.fn('flowdeck.test.runLocalShellProbe')(function* (workspace: WorkspaceClient, path: string) {
  const command = path === '/unsupported' ? 'node --version' : `cat ${persistedPath}`
  const execution = yield* Effect.acquireRelease(
    Effect.promise(async () => workspace.runtime.exec(command, { encoding: 'utf8' })),
    (active) =>
      Effect.sync(() => {
        active[Symbol.dispose]()
      }),
  )
  const result = yield* Effect.promise(async () => execution.result())
  return Response.json(result)
})

const workspaceResponse = Effect.fn('flowdeck.test.exerciseNativeShellWorkspace')(function* (path: string) {
  const { workspace } = yield* makeWorkerShellWorkspace
  if (path === '/write') {
    yield* Effect.promise(async () => workspace.fs.writeFile(persistedPath, 'durable workspace'))
    return Response.json({ written: true })
  }
  if (path === '/read') {
    const text = yield* Effect.promise(async () => workspace.fs.readFile(persistedPath, 'utf8'))
    return Response.json({ text })
  }
  return yield* shellResult(workspace, path)
})

const handle = Effect.fn('flowdeck.test.dispatchWorkerShellProbe')((request: globalThis.Request) => {
  const path = new URL(request.url).pathname
  return path === '/sdk' ? sdkReadiness(request) : workspaceResponse(path)
})
const fetch = Request.pipe(
  Effect.flatMap(handle),
  Effect.map(HttpServerResponse.fromWeb),
  Effect.provideService(Store, store),
  Effect.scoped,
)

// Alchemy's outer bridge supplies the native state for the production shell.
export const entrypoint = Effect.gen(function* () {
  yield* runtime.export('DevelopmentRun', {
    constructor: Effect.succeed(Effect.succeed({ fetch })),
    kind: 'durableObject',
    services: Context.empty(),
  })
  return { RuntimeContext: runtime }
})

const bridge = makeDurableObjectBridge(DurableObject, {
  entrypoint,
  stack: { name: 'worker-shell-boundary', stage: 'test' },
})

// oxlint-disable-next-line typescript/no-unsafe-assignment -- The public Alchemy bridge returns its generated native class as any.
export const DevelopmentRun = bridge('DevelopmentRun')

const probeWorker = {
  async fetch(request: globalThis.Request, env: { PROBE: DurableObjectNamespace }): Promise<Response> {
    const id = env.PROBE.idFromName('workspace')
    return env.PROBE.get(id).fetch(request)
  },
}

// oxlint-disable-next-line import/no-default-export -- Workerd dispatches requests to the default fixture Worker.
export default probeWorker
