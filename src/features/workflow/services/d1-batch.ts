import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { Effect } from 'effect'

import { WorkflowDatabase, execute, withD1BindingContext } from './database'

export const makeD1Batch = Effect.gen(function* () {
  const database = yield* WorkflowDatabase
  return Effect.fn('D1Store.batch')((statements: PreparedStatement[]) =>
    execute('batch', withD1BindingContext(database.batch(statements))),
  )
})
