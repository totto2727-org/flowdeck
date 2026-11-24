import { live } from '@effect/vitest'
import { QueryExecutor } from '@totto2727/reylo/effect'
import type { PreparedStatement } from 'alchemy/Cloudflare/D1'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Context, Effect } from 'effect'
import { describe, expect, expectTypeOf, vi } from 'vite-plus/test'

import { makeD1Batch } from './batch.ts'
import { D1Client } from './client.ts'
import { clientFor, makeD1TestDatabases, makeQueriesWithAlternate } from './test-fixture.ts'

describe('captured native D1 query requirements', () => {
  live('narrows only captured all and batch requirements, leaving SDK exec and raw unchanged', () =>
    Effect.gen(function* () {
      const { database } = yield* makeD1TestDatabases
      const client = yield* clientFor(database)
      const statement = client.prepare('SELECT 1 AS value').bind()
      const all = statement.all()
      const batch = client.batch([statement])
      const exec = client.exec('SELECT 1')
      expectTypeOf<Effect.Services<typeof all>>().toEqualTypeOf<never>()
      expectTypeOf<Effect.Services<typeof batch>>().toEqualTypeOf<never>()
      expectTypeOf<Effect.Services<typeof client.raw>>().toEqualTypeOf<RuntimeContext>()
      expectTypeOf<Effect.Services<typeof exec>>().toEqualTypeOf<RuntimeContext>()
    }),
  )

  live('prepares, batches and reads without using a caller-selected database', () =>
    Effect.gen(function* () {
      const { batch, batchContext, otherDatabase, read, readContext } = yield* makeQueriesWithAlternate
      expectTypeOf<Effect.Services<typeof batch>>().toEqualTypeOf<never>()
      expectTypeOf<Effect.Services<typeof read>>().toEqualTypeOf<never>()
      yield* batch.pipe(Effect.provideContext(batchContext))
      const unexpected = vi.fn<QueryExecutor['Service']['execute']>(() =>
        Effect.die('Caller QueryExecutor must not run'),
      )
      const observed = [
        yield* read,
        yield* read.pipe(
          Effect.provideContext(Context.add(readContext, QueryExecutor, { dialect: 'sqlite', execute: unexpected })),
        ),
      ]
      expect(observed).toStrictEqual([{ value: 7 }, { value: 7 }])
      expect(unexpected).not.toHaveBeenCalled()
      const count = yield* Effect.promise(async () =>
        otherDatabase.prepare('SELECT count(*) AS count FROM entries').first(),
      )
      expect(count).toStrictEqual({ count: 0 })
    }),
  )
})

describe('native D1 prepared batches', () => {
  live('executes an existing batch without calling the public client prepare again', () =>
    Effect.gen(function* () {
      expectTypeOf<Parameters<Effect.Success<typeof makeD1Batch>>[number]>().toEqualTypeOf<PreparedStatement[]>()
      const { database } = yield* makeD1TestDatabases
      const client = yield* clientFor(database)
      const statement = client.prepare('INSERT INTO entries (value) VALUES (?)').bind(11)
      const prepare = vi.fn<D1Client['Service']['prepare']>()
      const batch = yield* makeD1Batch.pipe(Effect.provideService(D1Client, { ...client, prepare }))
      yield* batch([statement])
      expect(prepare).not.toHaveBeenCalled()
      const row = yield* Effect.promise(async () => database.prepare('SELECT value FROM entries').first())
      expect(row).toStrictEqual({ value: 11 })
    }),
  )
})
