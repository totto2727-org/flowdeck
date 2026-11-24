import { defineQuery } from '@totto2727/reylo'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { makeWorkerRuntimeContext } from 'alchemy/Cloudflare/Workers/WorkerRuntimeContext'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Context, Effect, Layer } from 'effect'
import { Miniflare } from 'miniflare'

import { D1Client } from './client.ts'
import { D1Binding, NativeD1Client } from './native.ts'
import { AlchemyQueryExecutorLive, makeD1Queries } from './reylo.ts'

export const insertValue = defineQuery<{ value: number }, never, 'none', 'sqlite'>({
  cardinality: 'none',
  columns: [],
  dialect: 'sqlite',
  inputs: { value: { nullable: false, type: { kind: 'scalar', name: 'INTEGER' } } },
  params: ['value'],
  sql: 'INSERT INTO entries (value) VALUES (:value)',
})

export const readValue = defineQuery<Record<string, never>, { value: number }, 'one', 'sqlite'>({
  cardinality: 'one',
  columns: [['value', 'int']],
  dialect: 'sqlite',
  params: [],
  sql: 'SELECT value FROM entries',
})

export const makeD1TestDatabases = Effect.gen(function* () {
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare({
          compatibilityDate: '2026-07-30',
          d1Databases: { DB: 'd1-capability', OTHER: 'other-d1-capability' },
          modules: true,
          script: 'export default {}',
        }),
    ),
    (instance) => Effect.promise(async () => instance.dispose()),
  )
  const database = yield* Effect.promise(async () => runtime.getD1Database('DB'))
  const otherDatabase = yield* Effect.promise(async () => runtime.getD1Database('OTHER'))
  yield* Effect.forEach(
    [database, otherDatabase],
    (binding) => Effect.promise(async () => binding.exec('CREATE TABLE entries (value INTEGER)')),
    { concurrency: 'unbounded', discard: true },
  )
  return { database, otherDatabase }
})

export const clientFor = (binding: D1Binding['Service']): Effect.Effect<D1Client['Service']> => {
  const bindingLayer = Layer.succeed(D1Binding, binding)
  const clientLayer = NativeD1Client.pipe(Layer.provide(bindingLayer))
  return D1Client.pipe(Effect.provide(clientLayer))
}

export const queriesFor = (client: D1Client['Service']): Effect.Effect<Effect.Success<typeof makeD1Queries>> => {
  const clientLayer = Layer.succeed(D1Client, client)
  const dependencies = AlchemyQueryExecutorLive.pipe(Layer.provideMerge(clientLayer))
  return makeD1Queries.pipe(Effect.provide(dependencies))
}

export const makeQueriesWithAlternate = Effect.gen(function* () {
  const { database, otherDatabase } = yield* makeD1TestDatabases
  const original = yield* clientFor(database)
  const alternate = yield* clientFor(otherDatabase)
  const queries = yield* queriesFor({ ...original, raw: Effect.die('Exposed raw access is forbidden') })
  const statement = yield* queries.prepare(insertValue, { value: 7 })
  const supplied = Context.make(D1Client, alternate).pipe(Context.add(WorkerEnvironment, { DB: otherDatabase }))
  const batchRuntime = makeWorkerRuntimeContext('conflicting-batch-runtime')
  const readRuntime = makeWorkerRuntimeContext('conflicting-read-runtime')
  return {
    batch: queries.batch([statement]),
    batchContext: Context.add(supplied, RuntimeContext, batchRuntime),
    otherDatabase,
    read: queries.run(readValue),
    readContext: Context.add(supplied, RuntimeContext, readRuntime),
  }
})
