import type { ParamsArg, StandardQueryV1 } from '@totto2727/reylo'
import * as QueryEffect from '@totto2727/reylo/effect'
import { Effect, Layer } from 'effect'

import { makeD1Batch } from './batch'
import { D1Client } from './client'

export const AlchemyQueryExecutorLive = Layer.effect(
  QueryEffect.QueryExecutor,
  Effect.gen(function* () {
    const database = yield* D1Client
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
        ),
    })
  }),
)

export const makeD1Queries = Effect.gen(function* () {
  const database = yield* D1Client
  const run = yield* QueryEffect.makeQueryRunner
  const prepare = <Input, Output>(
    query: StandardQueryV1<Input, Output, 'sqlite'>,
    ...input: ParamsArg<NoInfer<Input>>
  ) =>
    QueryEffect.prepare(query, ...input).pipe(
      Effect.map((statement) => database.prepare(statement.text).bind(...statement.values)),
    )
  return { run, prepare, batch: yield* makeD1Batch }
})
