import type { D1Database } from '@cloudflare/workers-types'
import { makeQueryDatabaseClientFrom } from 'alchemy/Cloudflare/D1'
import { Context, Effect, Layer } from 'effect'

import { WorkflowDatabase } from './database'

export class D1Binding extends Context.Service<D1Binding, D1Database>()('flowdeck/D1Binding') {}

// Native Durable Objects lack Alchemy's Worker construction context.
// Reuse its existing client builder rather than duplicating its executor.
export const NativeWorkflowDatabase = Layer.effect(
  WorkflowDatabase,
  D1Binding.pipe(Effect.map((binding) => makeQueryDatabaseClientFrom(Effect.succeed(binding)))),
)
