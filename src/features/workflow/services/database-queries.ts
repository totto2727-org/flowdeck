import type { Cardinality, Query } from '@totto2727/reylo'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, String } from 'effect'

import { ExternalError, StorageConflict } from '../domain/errors'
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
    Effect.provide(RuntimeContext.phantom),
  )

export const prepare = <Input, Row, C extends Cardinality>(
  query: Query<Input, Row, C, 'sqlite'>,
  input: NoInfer<Input>,
) =>
  Effect.gen(function* () {
    const database = yield* WorkflowDatabase
    const statement = query['~standard'].query
    return database.prepare(statement.text).bind(...statement.encode(input))
  })

export const first = <Input, Row, C extends Cardinality>(
  query: Query<Input, Row, C, 'sqlite'>,
  input: NoInfer<Input>,
) => prepare(query, input).pipe(Effect.flatMap((statement) => statement.first<Row>()))

export const all = <Input, Row, C extends Cardinality>(query: Query<Input, Row, C, 'sqlite'>, input: NoInfer<Input>) =>
  prepare(query, input).pipe(
    Effect.flatMap((statement) => statement.all<Row>()),
    Effect.map((result) => result.results),
  )

export const batch = (statements: PreparedStatement[]) =>
  execute('batch', WorkflowDatabase.pipe(Effect.flatMap((database) => database.batch(statements))))
