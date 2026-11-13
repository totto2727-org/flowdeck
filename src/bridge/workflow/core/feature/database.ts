import { QueryDatabase } from 'alchemy/Cloudflare/D1'
import { Effect, Layer } from 'effect'

import { D1Client } from '@/core/feature/d1/client'
import { AlchemyQueryExecutorLive } from '@/core/feature/d1/reylo'
import { D1StoreLive } from '@/core/feature/workflow/services/d1-store'
import { DatabaseQueriesLive } from '@/core/feature/workflow/services/database-queries'
import { Database } from '@/core/worker/database'

const WorkflowDatabaseLive = Layer.effect(
  D1Client,
  Effect.gen(function* () {
    return D1Client.fromBinding(yield* QueryDatabase(yield* Database))
  }),
)

export const WorkflowStoreLive = D1StoreLive.pipe(
  Layer.provide(DatabaseQueriesLive),
  Layer.provide(AlchemyQueryExecutorLive),
  Layer.provide(WorkflowDatabaseLive),
)
