import { Workspace } from '@cloudflare/computer'
import type { WorkspaceProxyProps } from '@cloudflare/computer'
import type { Fetcher } from '@cloudflare/workers-types'
import type { DurableObjectState } from 'alchemy/Cloudflare/Workers/DurableObjectState'
import { Clock, Effect } from 'effect'
import { HttpServerResponse } from 'effect/http'

import type { makePiSdk } from '@/core/worker/pi/sdk-runtime'

type RawState = DurableObjectState['Service']['raw']
type PiSdk = Effect.Success<typeof makePiSdk>
interface Loopback {
  WorkspaceProxy: (options: { props: WorkspaceProxyProps }) => Fetcher
}

const persistedSql = 'SELECT 1 AS value'
const oneMillisecond = 1

const scheduleJob = Effect.fn('flowdeck.test.scheduleSdkAlarm')(function* (sdk: PiSdk) {
  yield* Effect.promise(async () => sdk.lifecycle.start())
  const now = yield* Clock.currentTimeMillis
  yield* Effect.promise(async () =>
    sdk.lifecycle.jobs.push({ fn: 'unknown-test-job', id: 'test-alarm', time: now - oneMillisecond }),
  )
  return { queued: sdk.lifecycle.jobs.list().length }
})

const observeJobs = Effect.fn('flowdeck.test.readSdkLifecycle')(function* (sdk: PiSdk) {
  yield* Effect.promise(async () => sdk.lifecycle.start())
  return { jobs: sdk.lifecycle.jobs.list().length }
})

const loopbackProxy = async (raw: RawState): Promise<Readonly<{ status: number; text: string }>> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vite adds the native loopback export at build time; Workerd calls its real binding here.
  const exports = raw.exports as Loopback
  const proxy = exports.WorkspaceProxy({ props: { binding: 'PROBE', id: raw.id.toString() } })
  const response = await proxy.fetch('https://workspace-proxy/health')
  return { status: response.status, text: await response.text() }
}

export const exposeSdkMethods = Effect.fn('flowdeck.test.exposeDevelopmentSdkFixture')((sdk: PiSdk, raw: RawState) =>
  Effect.succeed({
    alarm: () => Effect.promise(async () => sdk.lifecycle.alarm()),
    capnwebTarget: () =>
      Effect.promise(async () => {
        // Deliberately return the Capnweb target to check its native RPC incompatibility.
        const workspace = new Workspace({ storage: raw.storage })
        await workspace.ready()
        return workspace.stub()
      }),
    fetch: observeJobs(sdk).pipe(Effect.map(HttpServerResponse.jsonUnsafe)),
    inspect: () =>
      observeJobs(sdk).pipe(
        Effect.map(({ jobs }) => ({ jobs, sqlite: raw.storage.sql.exec<{ value: number }>(persistedSql).one().value })),
      ),
    proxyHealth: () => Effect.promise(async () => loopbackProxy(raw)),
    schedule: () => scheduleJob(sdk),
  }),
)
