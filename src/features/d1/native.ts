import type { D1Database } from '@cloudflare/workers-types'
import { makeQueryDatabaseClientFrom } from 'alchemy/Cloudflare/D1'
import { Context, Effect, Layer } from 'effect'

import { D1Client } from './client'

export class D1Binding extends Context.Service<D1Binding, D1Database>()('flowdeck/D1Binding') {}

// Native callers lack Alchemy's Worker construction context. Its official client
// builder captures this already resolved binding, with no deferred runtime lookup.
export const NativeD1Client = Layer.effect(
  D1Client,
  D1Binding.pipe(Effect.map((binding) => D1Client.fromBinding(makeQueryDatabaseClientFrom(Effect.succeed(binding))))),
)
