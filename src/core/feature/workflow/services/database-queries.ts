import type { ParamsArg, StandardQueryV1 } from '@totto2727/reylo'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { Context, Effect, Layer } from 'effect'

import { makeD1Queries } from '@/core/feature/d1/reylo'
import type { ExternalError, StorageConflict } from '@/core/feature/workflow/domain/errors'

import { execute } from './database.ts'

type DatabaseFailure = StorageConflict | ExternalError

export const makeDatabaseQueries = Effect.gen(function* () {
  const queries = yield* makeD1Queries
  const prepare = <Input, Output>(
    query: StandardQueryV1<Input, Output, 'sqlite'>,
    ...input: ParamsArg<NoInfer<Input>>
  ): Effect.Effect<PreparedStatement, DatabaseFailure> =>
    execute('prepare batch statement', queries.prepare(query, ...input))
  const read = <Input, Output>(
    operation: string,
    query: StandardQueryV1<Input, Output, 'sqlite'>,
    ...input: ParamsArg<NoInfer<Input>>
  ): Effect.Effect<Output, DatabaseFailure> => execute(operation, queries.run(query, ...input))
  return {
    batch: (statements: PreparedStatement[]) => execute('batch', queries.batch(statements)),
    prepare,
    read,
    run: queries.run,
  }
})

export class DatabaseQueries extends Context.Service<DatabaseQueries, Effect.Success<typeof makeDatabaseQueries>>()(
  'flowdeck/DatabaseQueries',
) {}

export const DatabaseQueriesLive = Layer.effect(DatabaseQueries, makeDatabaseQueries)
