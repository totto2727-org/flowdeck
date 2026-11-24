import { live } from '@effect/vitest'
import { defineQuery } from '@totto2727/reylo'
import { QueryDecodeError, QueryExecutor } from '@totto2727/reylo/effect'
import { Data, Effect, Exit, Fiber, Predicate } from 'effect'
import { expect, expectTypeOf, vi } from 'vite-plus/test'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { execute } from '@/core/feature/workflow/services/database'

import { clientForDatabase, queriesWithClient } from './d1-workflow-database.fixture.ts'
import { d1Fixture } from './d1-workflows.fixture.ts'

type NoQueryParams = Record<string, never>
class AdapterFixtureError extends Data.TaggedError('AdapterFixtureError')<{ message: string }> {}
const decodedQuery = defineQuery<{ active: boolean }, { active: boolean; document: { name: string } }, 'one', 'sqlite'>(
  {
    cardinality: 'one',
    columns: [
      ['active', 'bool'],
      ['document', 'json'],
    ],
    dialect: 'sqlite',
    inputs: { active: { nullable: false, type: { kind: 'scalar', name: 'BOOLEAN' } } },
    params: ['active'],
    sql: `SELECT :active AS active, '{"name":"Flowdeck"}' AS document`,
  },
)
const cardinalityQuery = defineQuery<NoQueryParams, { value: number }, 'one', 'sqlite'>({
  cardinality: 'one',
  columns: [['value', 'int']],
  dialect: 'sqlite',
  params: [],
  sql: 'SELECT 1 AS value UNION ALL SELECT 2 AS value',
})
const preparedQuery = defineQuery<{ value: number }, never, 'none', 'sqlite'>({
  cardinality: 'none',
  columns: [],
  dialect: 'sqlite',
  inputs: { value: { nullable: false, type: { kind: 'scalar', name: 'INTEGER' } } },
  params: ['value'],
  sql: 'INSERT INTO workflows (workflow_id, name) VALUES (:value, :value)',
})
const singleValueQuery = defineQuery<NoQueryParams, { value: number }, 'one', 'sqlite'>({
  cardinality: 'one',
  columns: [['value', 'int']],
  dialect: 'sqlite',
  params: [],
  sql: 'SELECT 1 AS value',
})

live('uses the published Reylo decoder and captured Alchemy executor despite a conflicting caller context', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const queries = yield* fixture.freshQueries()
    const result = queries.run(decodedQuery, { active: true })
    expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<never>()
    const unexpected = vi.fn<typeof QueryExecutor.Service.execute>(() =>
      Effect.die('The caller executor must not be used'),
    )
    const expected = { active: true, document: { name: 'Flowdeck' } }
    const observed = yield* result
    const underConflictingContext = yield* result.pipe(
      Effect.provideService(QueryExecutor, { dialect: 'sqlite', execute: unexpected }),
    )
    expect([observed, underConflictingContext]).toStrictEqual([expected, expected])
    expect(unexpected).not.toHaveBeenCalled()
  }),
)

live('maps a published Reylo cardinality failure to a storage failure without losing its original cause', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const queries = yield* fixture.freshQueries()
    const queryError = yield* queries.run(cardinalityQuery).pipe(Effect.flip)
    expect(queryError).toBeInstanceOf(QueryDecodeError)
    const error = yield* execute('read one value', Effect.fail(queryError)).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExternalError)
    expect(error.cause).toBe(queryError.cause)
    expect(error).toMatchObject({ kind: 'storage', operation: 'read one value' })
    const message = Predicate.hasProperty(error.cause, 'message') && error.cause.message
    expect(message).toContain('Expected exactly one row, got 2')
  }),
)

live('retains a preparation failure before constructing or executing an atomic write batch', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const cause = new AdapterFixtureError({ message: 'Input accessor failed' })
    const input = {
      get value(): number {
        throw cause
      },
    }
    const queries = yield* fixture.freshQueries()
    const error = yield* queries.prepare(preparedQuery, input).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExternalError)
    expect(error.cause).toBe(cause)
    expect(yield* fixture.store.listRuns).toStrictEqual([])
    const count = yield* Effect.promise(async () =>
      fixture.database.prepare('SELECT count(*) AS count FROM workflows').first(),
    )
    expect(count).toStrictEqual({ count: 0 })
  }),
)

const interruptedQueries = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  const client = yield* clientForDatabase(fixture.database)
  const statement = client.prepare('SELECT 1 AS value')
  const bind = vi.spyOn(statement, 'bind').mockReturnValue(statement)
  const interrupt = vi.spyOn(statement, 'all').mockReturnValue(Effect.interrupt)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      interrupt.mockRestore()
      bind.mockRestore()
    }),
  )
  return yield* queriesWithClient({ ...client, prepare: () => statement })
})

live('preserves read interruption through the Alchemy executor and published query runner', () =>
  Effect.gen(function* () {
    const queries = yield* interruptedQueries
    const read = queries.read('read value', singleValueQuery)
    const fiber = yield* Effect.forkScoped(read)
    const outcome = yield* Fiber.await(fiber)
    expect(Exit.hasInterrupts(outcome)).toBe(true)
  }),
)
