import { Workspace } from '@cloudflare/computer'
import { makeDurableObjectBridge } from 'alchemy/Cloudflare/Bridge'
import { DurableObjectState } from 'alchemy/Cloudflare/Workers/DurableObjectState'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers/WorkerRuntime'
import { makeWorkerRuntimeContext } from 'alchemy/Cloudflare/Workers/WorkerRuntimeContext'
import { DurableObject } from 'cloudflare:workers'
import { Context, Effect, Layer } from 'effect'
import { HttpServerResponse } from 'effect/http'

import { Store } from '../../src/features/workflow/services/store'
import { makeDevelopmentSdk } from '../../src/workers/development-workflow/sdk-runtime'

const unexpected = Effect.die(new Error('Unexpected workflow persistence access'))
const StoreLive = Layer.succeed(
  Store,
  Store.of({
    create: () => unexpected,
    listRuns: unexpected,
    getRun: () => unexpected,
    getGraph: () => unexpected,
    getEvents: () => unexpected,
    commit: () => unexpected,
  }),
)
const runtime = makeWorkerRuntimeContext('SdkBoundaryTest')

/** Use Alchemy's real bridge with the production SDK adapter, not a fake native host. */
export const entrypoint = Effect.gen(function* () {
  yield* runtime.export('SdkBoundary', {
    kind: 'durableObject',
    services: Context.empty(),
    constructor: Effect.gen(function* () {
      const environment = yield* WorkerEnvironment
      return Effect.gen(function* () {
        const state = yield* DurableObjectState
        const sdk = yield* makeDevelopmentSdk.pipe(
          Effect.provide(StoreLive),
          Effect.provideService(WorkerEnvironment, environment),
        )
        return {
          inspect: () =>
            Effect.promise(async () => {
              await sdk.lifecycle.start()
              return {
                jobs: sdk.lifecycle.jobs.list().length,
                sqlite: state.raw.storage.sql.exec('SELECT 1 AS value').one().value,
              }
            }),
          // The SDK stub is a Capnweb target. This deliberately probes its
          // native wire incompatibility, not a production method or workaround.
          capnwebTarget: () =>
            Effect.promise(async () => {
              const workspace = new Workspace({ storage: state.raw.storage })
              await workspace.ready()
              return workspace.stub()
            }),
          proxyHealth: () =>
            Effect.promise(async () => {
              const proxy = state.raw.exports.WorkspaceProxy({
                props: { binding: 'PROBE', id: state.raw.id.toString() },
              })
              const response = await proxy.fetch('https://workspace-proxy/health')
              return { status: response.status, text: await response.text() }
            }),
          schedule: () =>
            Effect.promise(async () => {
              await sdk.lifecycle.start()
              await sdk.lifecycle.jobs.push({ id: 'test-alarm', fn: 'unknown-test-job', time: Date.now() - 1 })
              return { queued: sdk.lifecycle.jobs.list().length }
            }),
          fetch: Effect.gen(function* () {
            yield* Effect.promise(() => sdk.lifecycle.start())
            return HttpServerResponse.jsonUnsafe({ jobs: sdk.lifecycle.jobs.list().length })
          }),
          alarm: () => Effect.promise(() => sdk.lifecycle.alarm()),
        }
      })
    }),
  })
  return { RuntimeContext: runtime }
})

export const SdkBoundary = makeDurableObjectBridge(DurableObject, {
  entrypoint,
  stack: { name: 'sdk-boundary', stage: 'test' },
})('SdkBoundary')

export default entrypoint
