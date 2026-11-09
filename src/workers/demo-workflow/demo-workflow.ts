import { BrowserCrypto } from '@effect/platform-browser'
import reylo from '@totto2727/reylo/vite'
import { QueryDatabase, QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { DurableObject } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer, Schema } from 'effect'

import { D1Client } from '@/features/d1/client'
import { AlchemyQueryExecutorLive } from '@/features/d1/reylo'
import { RunId } from '@/features/workflow/domain/identity'
import { makeRpcResponse } from '@/features/workflow/rpc/boundary'
import { rpcCall, rpcCommandResult, type WireWorkflowExecutor } from '@/features/workflow/rpc/contract'
import { D1StoreLive } from '@/features/workflow/services/d1-store'
import { DatabaseQueriesLive } from '@/features/workflow/services/database-queries'
import { Database } from '@/workers/database'
import { DemoWorkflow } from '@/workers/definitions'

import { DemoExecutor, makeDemoExecutor } from './features/demo'

const decodeRunId = Schema.decodeUnknownEffect(RunId)

const makeDemoRunRuntime = Effect.gen(function* () {
  const database = yield* QueryDatabase(yield* Database)
  return Layer.mergeAll(
    Layer.effect(DemoExecutor, makeDemoExecutor).pipe(
      Layer.provide(
        Layer.mergeAll(
          D1StoreLive.pipe(
            Layer.provide(DatabaseQueriesLive),
            Layer.provide(AlchemyQueryExecutorLive),
            Layer.provide(Layer.succeed(D1Client, D1Client.fromBinding(database))),
          ),
          BrowserCrypto.layer,
        ),
      ),
    ),
    BrowserCrypto.layer,
  )
})

/** Each logical run name resolves to one object, but no checkpoint lives in memory. */
export class FlowdeckRun extends DurableObject<FlowdeckRun>()(
  'FlowdeckRun',
  Effect.gen(function* () {
    // QueryDatabase registers the static binding in Alchemy's construction phase.
    // The returned complete Layer initializes the object services only once in
    // the separate DO runtime phase, not when each RPC operation is called.
    const runtime = yield* makeDemoRunRuntime
    return Effect.gen(function* () {
      const executor = yield* DemoExecutor
      const respond = yield* makeRpcResponse
      return {
        start: (runId: RunId) =>
          decodeRunId(runId).pipe(Effect.flatMap(executor.start), Effect.as(null), respond('FlowdeckRun.start')),
        resume: (runId: RunId) =>
          decodeRunId(runId).pipe(Effect.flatMap(executor.resume), Effect.as(null), respond('FlowdeckRun.resume')),
      } satisfies WireWorkflowExecutor
    }).pipe(Effect.provide(runtime))
  }).pipe(Effect.provide(QueryDatabaseBinding)),
) {}

/** The entry resolves a run namespace and forwards only the fixed demo operations. */
export default DemoWorkflow.make(
  {
    main: import.meta.url,
    build: { input: { plugins: [reylo()] } },
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    workersDev: { enabled: false, previewsEnabled: false },
    dev: { host: '127.0.0.1', port: 4382, strictPort: true },
  },
  Effect.gen(function* () {
    const runs = yield* FlowdeckRun
    const respond = yield* makeRpcResponse
    return {
      start: (runId: RunId) =>
        decodeRunId(runId).pipe(
          Effect.flatMap((id) => runs.getByName(id).start(id).pipe(rpcCall('FlowdeckRun.start'))),
          Effect.flatMap(rpcCommandResult('FlowdeckRun.start')),
          Effect.as(null),
          respond('DemoWorkflow.start'),
        ),
      resume: (runId: RunId) =>
        decodeRunId(runId).pipe(
          Effect.flatMap((id) => runs.getByName(id).resume(id).pipe(rpcCall('FlowdeckRun.resume'))),
          Effect.flatMap(rpcCommandResult('FlowdeckRun.resume')),
          Effect.as(null),
          respond('DemoWorkflow.resume'),
        ),
    } satisfies WireWorkflowExecutor
  }).pipe(Effect.provide(BrowserCrypto.layer)),
)
