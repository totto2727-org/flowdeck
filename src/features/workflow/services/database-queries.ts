import type { Cardinality, Query } from '@totto2727/reylo'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Context, Effect, Layer, String } from 'effect'

import { ExternalError, StorageConflict } from '@/features/workflow/domain/errors'

import { WorkflowDatabase } from './database'

const databaseFailure = (operation: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : 'Database operation failed'
  return String.includes('flowdeck_')(message) || String.includes('UNIQUE constraint')(message)
    ? new StorageConflict({ message, operation, cause })
    : new ExternalError({ operation, cause, kind: 'storage' })
}

export const execute = <A, R>(operation: string, effect: Effect.Effect<A, never, R>) =>
  effect.pipe(
    Effect.catchDefect((cause) => Effect.fail(databaseFailure(operation, cause))),
    // Alchemy declares RuntimeContext on PreparedStatement methods even though
    // our QueryDatabaseBinding client already captures WorkerEnvironment during
    // construction, and the native test client captures its resolved D1 binding.
    // Neither selected executor reads RuntimeContext when executing a statement.
    // The SDK's phantom is an empty Layer: it narrows this excess requirement,
    // not an application dependency injected per operation. It wraps the statement
    // here because root provision alone cannot narrow returned Store signatures.
    // Reassess this exception before selecting an HTTP/deferred-binding executor
    // that genuinely resolves its database through RuntimeContext at execution.
    Effect.provide(RuntimeContext.phantom),
  )

export const makeDatabaseQueries = Effect.gen(function* () {
  const database = yield* WorkflowDatabase
  const prepare = <Input, Row, C extends Cardinality>(query: Query<Input, Row, C, 'sqlite'>, input: NoInfer<Input>) =>
    Effect.sync(() => {
      const statement = query['~standard'].query
      return database.prepare(statement.text).bind(...statement.encode(input))
    })
  const first = <Input, Row, C extends Cardinality>(query: Query<Input, Row, C, 'sqlite'>, input: NoInfer<Input>) =>
    prepare(query, input).pipe(Effect.flatMap((statement) => statement.first<Row>()))
  const all = <Input, Row, C extends Cardinality>(query: Query<Input, Row, C, 'sqlite'>, input: NoInfer<Input>) =>
    prepare(query, input).pipe(
      Effect.flatMap((statement) => statement.all<Row>()),
      Effect.map((result) => result.results),
    )
  const batch = Effect.fn('D1Store.batch')(function* (statements: PreparedStatement[]) {
    return yield* execute('batch', database.batch(statements))
  })
  return { prepare, first, all, batch }
})

export class DatabaseQueries extends Context.Service<DatabaseQueries, Effect.Success<typeof makeDatabaseQueries>>()(
  'flowdeck/DatabaseQueries',
) {}

export const DatabaseQueriesLive = Layer.effect(DatabaseQueries, makeDatabaseQueries)
