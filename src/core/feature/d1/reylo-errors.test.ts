import { live } from '@effect/vitest'
import { QueryExecutionError, QueryPreparationError } from '@totto2727/reylo/effect'
import { Data, Effect, Exit, Fiber } from 'effect'
import { describe, expect, vi } from 'vite-plus/test'

import { clientFor, insertValue, makeD1TestDatabases, queriesFor, readValue } from './test-fixture.ts'

class FixtureFailure extends Data.TaggedError('FixtureFailure')<{ message: string }> {}

describe('native D1 query failures', () => {
  live('preserves a preparation failure without executing a batch or inventing a storage error', () =>
    Effect.gen(function* () {
      const { database } = yield* makeD1TestDatabases
      const client = yield* clientFor(database)
      const queries = yield* queriesFor(client)
      const cause = new FixtureFailure({ message: 'Input accessor failed' })
      const input = {
        get value(): number {
          throw cause
        },
      }
      const error = yield* queries.prepare(insertValue, input).pipe(Effect.flip)
      expect(error).toBeInstanceOf(QueryPreparationError)
      expect(error.cause).toBe(cause)
      const count = yield* Effect.promise(async () => database.prepare('SELECT count(*) AS count FROM entries').first())
      expect(count).toStrictEqual({ count: 0 })
    }),
  )

  live('retains the original execution defect inside the official Reylo error', () =>
    Effect.gen(function* () {
      const { database } = yield* makeD1TestDatabases
      const client = yield* clientFor(database)
      const statement = client.prepare('SELECT value FROM entries')
      const cause = new FixtureFailure({ message: 'Native D1 execution failed' })
      const spies = [
        vi.spyOn(statement, 'bind').mockReturnValue(statement),
        vi.spyOn(statement, 'all').mockReturnValue(Effect.die(cause)),
      ] as const
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          const [bind, all] = spies
          all.mockRestore()
          bind.mockRestore()
        }),
      )
      const queries = yield* queriesFor({ ...client, prepare: () => statement })
      const error = yield* queries.run(readValue).pipe(Effect.flip)
      expect(error).toBeInstanceOf(QueryExecutionError)
      expect(error.cause).toBe(cause)
    }),
  )
})

describe('native D1 batch interruption', () => {
  live('preserves interruption without converting it into an execution failure', () =>
    Effect.gen(function* () {
      const { database } = yield* makeD1TestDatabases
      const client = yield* clientFor(database)
      const queries = yield* queriesFor({ ...client, batch: () => Effect.interrupt })
      const statement = yield* queries.prepare(insertValue, { value: 19 })
      const fiber = yield* Effect.forkScoped(queries.batch([statement]))
      const exit = yield* Fiber.await(fiber)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      const count = yield* Effect.promise(async () => database.prepare('SELECT count(*) AS count FROM entries').first())
      expect(count).toStrictEqual({ count: 0 })
    }),
  )
})
