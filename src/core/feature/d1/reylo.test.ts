import type { D1Database } from '@cloudflare/workers-types'
import { defineQuery } from '@totto2727/reylo'
import { QueryExecutionError, QueryExecutor, QueryPreparationError } from '@totto2727/reylo/effect'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { makeWorkerRuntimeContext } from 'alchemy/Cloudflare/Workers/WorkerRuntimeContext'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Array, Effect, Exit, Layer } from 'effect'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'

import { makeD1Batch } from './batch'
import { D1Client } from './client'
import { D1Binding, NativeD1Client } from './native'
import { AlchemyQueryExecutorLive, makeD1Queries } from './reylo'

const insertValue = defineQuery<{ value: number }, never, 'none', 'sqlite'>({
  dialect: 'sqlite',
  sql: 'INSERT INTO entries (value) VALUES (:value)',
  params: ['value'],
  inputs: { value: { type: { kind: 'scalar', name: 'INTEGER' }, nullable: false } },
  columns: [],
  cardinality: 'none',
})
const readValue = defineQuery<{}, { value: number }, 'one', 'sqlite'>({
  dialect: 'sqlite',
  sql: 'SELECT value FROM entries',
  params: [],
  columns: [['value', 'int']],
  cardinality: 'one',
})

let miniflare: Miniflare
let database: D1Database
let otherDatabase: D1Database
const clientFor = (binding: D1Database) =>
  Effect.runSync(D1Client.pipe(Effect.provide(NativeD1Client.pipe(Layer.provide(Layer.succeed(D1Binding, binding))))))
const queriesFor = (client: D1Client['Service']) =>
  Effect.runSync(
    makeD1Queries.pipe(
      Effect.provide(AlchemyQueryExecutorLive.pipe(Layer.provideMerge(Layer.succeed(D1Client, client)))),
    ),
  )

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default {}',
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'd1-capability', OTHER: 'other-d1-capability' },
  })
  database = await miniflare.getD1Database('DB')
  otherDatabase = await miniflare.getD1Database('OTHER')
  await Promise.all(
    Array.map([database, otherDatabase], (binding) => binding.exec('CREATE TABLE entries (value INTEGER)')),
  )
})

afterEach(async () => {
  await miniflare.dispose()
})

describe('captured native D1 queries', () => {
  it('narrows only captured all and batch requirements, not the complete SDK client', () => {
    const client = clientFor(database)
    const statement = client.prepare('SELECT 1 AS value').bind()
    const all = statement.all()
    const batch = client.batch([statement])
    const exec = client.exec('SELECT 1')
    expectTypeOf<Effect.Services<typeof all>>().toEqualTypeOf<never>()
    expectTypeOf<Effect.Services<typeof batch>>().toEqualTypeOf<never>()
    expectTypeOf<Effect.Services<typeof client.raw>>().toEqualTypeOf<RuntimeContext>()
    expectTypeOf<Effect.Services<typeof exec>>().toEqualTypeOf<RuntimeContext>()
  })

  it('prepares, batches and reads without a RuntimeContext or a caller-selected database', async () => {
    const queries = queriesFor({ ...clientFor(database), raw: Effect.die('Exposed raw access is forbidden') })
    const statement = await Effect.runPromise(queries.prepare(insertValue, { value: 7 }))
    const batch = queries.batch([statement])
    const read = queries.run(readValue)
    expectTypeOf<Effect.Services<typeof batch>>().toEqualTypeOf<never>()
    expectTypeOf<Effect.Services<typeof read>>().toEqualTypeOf<never>()
    await Effect.runPromise(
      batch.pipe(
        Effect.provideService(D1Client, clientFor(otherDatabase)),
        Effect.provideService(WorkerEnvironment, { DB: otherDatabase }),
        Effect.provideService(RuntimeContext, makeWorkerRuntimeContext('conflicting-batch-runtime')),
      ),
    )
    expect(await Effect.runPromise(read)).toEqual({ value: 7 })
    const unexpected = vi.fn(() => Effect.die('Caller QueryExecutor must not run'))
    expect(
      await Effect.runPromise(
        read.pipe(
          Effect.provideService(D1Client, clientFor(otherDatabase)),
          Effect.provideService(WorkerEnvironment, { DB: otherDatabase }),
          Effect.provideService(RuntimeContext, makeWorkerRuntimeContext('conflicting-read-runtime')),
          Effect.provideService(QueryExecutor, { dialect: 'sqlite', execute: unexpected }),
        ),
      ),
    ).toEqual({ value: 7 })
    expect(unexpected).not.toHaveBeenCalled()
    expect(await otherDatabase.prepare('SELECT count(*) AS count FROM entries').first()).toEqual({ count: 0 })
  })

  it('executes an existing prepared batch without calling the public client prepare again', async () => {
    expectTypeOf<Parameters<Effect.Success<typeof makeD1Batch>>[0]>().toEqualTypeOf<PreparedStatement[]>()
    const client = clientFor(database)
    const statement = client.prepare('INSERT INTO entries (value) VALUES (?)').bind(11)
    const prepare = vi.fn(() => {
      throw new Error('Preparation belongs to the caller')
    })
    const batch = Effect.runSync(makeD1Batch.pipe(Effect.provideService(D1Client, { ...client, prepare })))
    await Effect.runPromise(batch([statement]))
    expect(prepare).not.toHaveBeenCalled()
    expect(await database.prepare('SELECT value FROM entries').first()).toEqual({ value: 11 })
  })

  it('preserves a preparation failure without executing a batch or inventing a storage error', async () => {
    const cause = new Error('Input accessor failed')
    const input = {
      get value(): number {
        throw cause
      },
    }
    const error = await Effect.runPromise(queriesFor(clientFor(database)).prepare(insertValue, input).pipe(Effect.flip))
    expect(error).toBeInstanceOf(QueryPreparationError)
    expect(error.cause).toBe(cause)
    expect(await database.prepare('SELECT count(*) AS count FROM entries').first()).toEqual({ count: 0 })
  })

  it('retains the original execution defect inside the official Reylo error', async () => {
    const client = clientFor(database)
    const statement = client.prepare('SELECT value FROM entries')
    const cause = new Error('Native D1 execution failed')
    const bind = vi.spyOn(statement, 'bind').mockReturnValue(statement)
    const all = vi.spyOn(statement, 'all').mockReturnValue(Effect.die(cause))
    try {
      const queries = queriesFor({ ...client, prepare: () => statement })
      const error = await Effect.runPromise(queries.run(readValue).pipe(Effect.flip))
      expect(error).toBeInstanceOf(QueryExecutionError)
      expect(error.cause).toBe(cause)
    } finally {
      all.mockRestore()
      bind.mockRestore()
    }
  })

  it('preserves batch interruption without converting it into an execution failure', async () => {
    const queries = queriesFor({ ...clientFor(database), batch: () => Effect.interrupt })
    const statement = await Effect.runPromise(queries.prepare(insertValue, { value: 19 }))
    const exit = await Effect.runPromiseExit(queries.batch([statement]))
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(await database.prepare('SELECT count(*) AS count FROM entries').first()).toEqual({ count: 0 })
  })
})
