import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { Effect } from 'effect'

import { D1Client } from './client'

export const makeD1Batch = Effect.gen(function* () {
  const database = yield* D1Client
  return Effect.fn('D1.batch')((statements: PreparedStatement[]) => database.batch(statements))
})
