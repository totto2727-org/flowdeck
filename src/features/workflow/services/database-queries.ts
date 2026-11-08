import type { ParamsArg, StandardQueryV1 } from '@totto2727/reylo'
import * as QueryEffect from '@totto2727/reylo/effect'
import { Context, Effect, Layer } from 'effect'

import { makeD1Batch } from './d1-batch'
import { WorkflowDatabase, execute, withD1BindingContext } from './database'

export const AlchemyQueryExecutorLive = Layer.effect(
  QueryEffect.QueryExecutor,
  Effect.gen(function* () {
    const database = yield* WorkflowDatabase
    return QueryEffect.QueryExecutor.of({
      dialect: 'sqlite',
      execute: (statement) =>
        Effect.suspend(() =>
          database
            .prepare(statement.text)
            .bind(...statement.values)
            .all(),
        ).pipe(
          Effect.map((result) => result.results),
          Effect.catchDefect((cause) => Effect.fail(new QueryEffect.QueryExecutionError({ cause }))),
          withD1BindingContext,
        ),
    })
  }),
)

export const makeDatabaseQueries = Effect.gen(function* () {
  const database = yield* WorkflowDatabase
  const run = yield* QueryEffect.makeQueryRunner
  const prepare = <Input, Output>(
    query: StandardQueryV1<Input, Output, 'sqlite'>,
    ...input: ParamsArg<NoInfer<Input>>
  ) =>
    execute(
      'prepare batch statement',
      QueryEffect.prepare(query, ...input).pipe(
        Effect.map((statement) => database.prepare(statement.text).bind(...statement.values)),
      ),
    )
  return { run, prepare, batch: yield* makeD1Batch }
})

export class DatabaseQueries extends Context.Service<DatabaseQueries, Effect.Success<typeof makeDatabaseQueries>>()(
  'flowdeck/DatabaseQueries',
) {}

export const DatabaseQueriesLive = Layer.effect(DatabaseQueries, makeDatabaseQueries)
