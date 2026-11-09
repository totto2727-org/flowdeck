import { BrowserCrypto } from '@effect/platform-browser'
import reylo from '@totto2727/reylo/vite'
import { QueryDatabase, QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { DurableObjectState, Request, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import type { WebSocket } from 'alchemy/Cloudflare/Workers/WebSocket'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Config, Context, Effect, Layer, Schema } from 'effect'
import { HttpServerResponse } from 'effect/http'

import { D1Client } from '@/features/d1/client'
import { AlchemyQueryExecutorLive } from '@/features/d1/reylo'
import { RunId } from '@/features/workflow/domain/identity'
import { makeRpcResponse } from '@/features/workflow/rpc/boundary'
import { rpcCall, rpcCommandResult } from '@/features/workflow/rpc/contract'
import { D1StoreLive } from '@/features/workflow/services/d1-store'
import { DatabaseQueriesLive } from '@/features/workflow/services/database-queries'
import { Database } from '@/workers/database'

import { DevelopmentContainer } from './container'
import { DevelopmentRun } from './development-run'
import { DevelopmentWorkflow } from './development-workflow'
import { DevelopmentExecutor, makeDevelopmentExecutor } from './features/development'
import { DevelopmentSandbox } from './features/sandbox'
import { workspaceProxyBuild } from './features/workspace-proxy-build'
import { DevelopmentSdk } from './sdk-service'

const decodeRunId = Schema.decodeUnknownEffect(RunId)

const DevelopmentRunLive = DevelopmentRun.make(
  Effect.gen(function* () {
    // Binding discovery only. The official Container is never started here.
    yield* DevelopmentContainer
    const database = yield* QueryDatabase(yield* Database)
    const environment = yield* WorkerEnvironment
    const StoreLive = D1StoreLive.pipe(
      Layer.provide(DatabaseQueriesLive),
      Layer.provide(AlchemyQueryExecutorLive),
      Layer.provide(Layer.succeed(D1Client, D1Client.fromBinding(database))),
    )
    // Native Cloudflare classes can only load inside workerd, not during Node
    // provisioning. This official SDK adapter loads once at actual activation.
    const SdkLive = Layer.effect(
      DevelopmentSdk,
      Effect.promise(() => import('./sdk-runtime')).pipe(
        Effect.flatMap(({ makeDevelopmentSdk }) => makeDevelopmentSdk),
      ),
    ).pipe(
      Layer.provideMerge(Layer.mergeAll(StoreLive, BrowserCrypto.layer, Layer.succeed(WorkerEnvironment, environment))),
    )
    const SandboxLive = Layer.effect(
      DevelopmentSandbox,
      Effect.map(DevelopmentSdk, (sdk) => sdk.sandbox),
    ).pipe(Layer.provideMerge(SdkLive))
    const RuntimeLive = Layer.effect(DevelopmentExecutor, makeDevelopmentExecutor).pipe(Layer.provideMerge(SandboxLive))
    return Effect.gen(function* () {
      const ambient = yield* Effect.context<DurableObjectState | RuntimeContext>()
      // One complete service graph per activation. Native SDK callbacks and exported
      // handlers enter its captured context, never rebuild Layers or inject at leaves.
      const services = yield* Layer.build(RuntimeLive)
      const context = Context.merge(ambient, services)
      const sdk = Context.get(services, DevelopmentSdk)
      const executor = Context.get(services, DevelopmentExecutor)
      const respond = yield* makeRpcResponse.pipe(Effect.provideContext(context))
      const command = (operation: string, execute: typeof executor.start) => (input: RunId) =>
        decodeRunId(input).pipe(
          Effect.flatMap((runId) => sdk.execute(runId, execute(runId))),
          Effect.as(null),
          respond(operation),
          // Cloudflare invokes an exported handler outside the activation Effect.
          // This root-only reentry restores the already built context, as Alchemy's
          // own DurableObjectBridge does for runtime event dispatch.
          Effect.provideContext(context),
        )
      return {
        start: command('DevelopmentRun.start', executor.start),
        resume: command('DevelopmentRun.resume', executor.resume),
        fetch: Request.pipe(
          Effect.flatMap((request) => sdk.fetch(request)),
          // Preserve the SDK's native WebSocket upgrade Response and its webSocket
          // handle. fromWeb would discard that runtime-owned upgrade capability.
          Effect.map((response) => HttpServerResponse.raw(response, { status: response.status })),
        ),
        alarm: () => Effect.promise(() => sdk.lifecycle.alarm()),
        webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) =>
          sdk.webSocketMessage(socket.ws, message),
        webSocketClose: (socket: WebSocket, code: number, reason: string, wasClean: boolean) =>
          sdk.webSocketClose(socket.ws, code, reason, wasClean),
        webSocketError: (socket: WebSocket, error: unknown) => sdk.webSocketError(socket.ws, error),
      }
    })
  }).pipe(Effect.provide(QueryDatabaseBinding)),
)

export default DevelopmentWorkflow.make(
  {
    main: import.meta.url,
    build: { input: { plugins: [reylo(), workspaceProxyBuild()] } },
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    workersDev: { enabled: false, previewsEnabled: false },
    dev: { host: '127.0.0.1', port: 4383, strictPort: true },
    env: {
      CLOUDFLARE_ACCOUNT_ID: Config.String('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_AI_GATEWAY_ID: Config.String('CLOUDFLARE_AI_GATEWAY_ID'),
      CLOUDFLARE_AI_GATEWAY_API_KEY: Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY'),
    },
  },
  Effect.gen(function* () {
    const runs = yield* DevelopmentRun
    const respond = yield* makeRpcResponse
    const command = (operation: 'start' | 'resume') => (input: RunId) =>
      decodeRunId(input).pipe(
        // Decode before namespace selection, DO activation, D1, or any SDK I/O.
        Effect.flatMap((runId) =>
          runs
            .getByName(runId)
            [operation](runId)
            .pipe(rpcCall(`DevelopmentRun.${operation}`)),
        ),
        Effect.flatMap(rpcCommandResult(`DevelopmentRun.${operation}`)),
        Effect.as(null),
        respond(`DevelopmentWorkflow.${operation}`),
      )
    return { start: command('start'), resume: command('resume') }
  }).pipe(Effect.provide(Layer.mergeAll(DevelopmentRunLive, BrowserCrypto.layer))),
)
