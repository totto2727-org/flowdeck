import { QueryDatabase } from 'alchemy/Cloudflare/D1'
import { Effect, Layer } from 'effect'

import { D1Client } from '@/core/feature/d1/client'
import { AlchemyQueryExecutorLive } from '@/core/feature/d1/reylo'
import { D1StoreLive } from '@/core/feature/workflow/services/d1-store'
import { DatabaseQueriesLive } from '@/core/feature/workflow/services/database-queries'
import { Database } from '@/core/worker/database'

export const makeWorkflowRunStore = Effect.gen(function* () {
  const database = yield* Database
  const binding = yield* QueryDatabase(database)
  const client = Layer.succeed(D1Client, D1Client.fromBinding(binding))
  return D1StoreLive.pipe(
    Layer.provide(DatabaseQueriesLive),
    Layer.provide(AlchemyQueryExecutorLive),
    Layer.provide(client),
  )
})
