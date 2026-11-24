import { BrowserCrypto } from '@effect/platform-browser'
import { QueryDatabase } from 'alchemy/Cloudflare/D1'
import { Effect, Layer } from 'effect'

import { D1Client } from '@/core/feature/d1/client'
import { AlchemyQueryExecutorLive } from '@/core/feature/d1/reylo'
import { D1StoreLive } from '@/core/feature/workflow/services/d1-store'
import { DatabaseQueriesLive } from '@/core/feature/workflow/services/database-queries'
import { Database } from '@/core/worker/database'

import { DemoExecutor, makeDemoExecutor } from './feature/demo.ts'

export const makeDemoRunRuntime = Effect.gen(function* () {
  const database = yield* Database
  const binding = yield* QueryDatabase(database)
  const client = Layer.succeed(D1Client, D1Client.fromBinding(binding))
  const store = D1StoreLive.pipe(
    Layer.provide(DatabaseQueriesLive),
    Layer.provide(AlchemyQueryExecutorLive),
    Layer.provide(client),
  )
  const dependencies = Layer.mergeAll(store, BrowserCrypto.layer)
  const executor = Layer.effect(DemoExecutor, makeDemoExecutor).pipe(Layer.provide(dependencies))
  return Layer.mergeAll(executor, BrowserCrypto.layer)
})
