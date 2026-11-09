import type { ParamsArg, StandardQueryV1 } from '@totto2727/reylo'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { Context, Effect, Layer } from 'effect'

import { makeD1Queries } from '@/features/d1/reylo'

import { execute } from './database'

export const makeDatabaseQueries = Effect.gen(function* () {
  const queries = yield* makeD1Queries
  const prepare = <Input, Output>(
    query: StandardQueryV1<Input, Output, 'sqlite'>,
    ...input: ParamsArg<NoInfer<Input>>
  ) => execute('prepare batch statement', queries.prepare(query, ...input))
  return {
    run: queries.run,
    prepare,
    batch: (statements: PreparedStatement[]) => execute('batch', queries.batch(statements)),
  }
})

export class DatabaseQueries extends Context.Service<DatabaseQueries, Effect.Success<typeof makeDatabaseQueries>>()(
  'flowdeck/DatabaseQueries',
) {}

export const DatabaseQueriesLive = Layer.effect(DatabaseQueries, makeDatabaseQueries)
