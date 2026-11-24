import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { Array, Data, Effect, Layer } from 'effect'
import { Miniflare } from 'miniflare'

import { D1Binding, NativeD1Client } from '@/core/feature/d1/native'
import { AlchemyQueryExecutorLive } from '@/core/feature/d1/reylo'
import { D1StoreLive } from '@/core/feature/workflow/services/d1-store'
import { DatabaseQueries, DatabaseQueriesLive } from '@/core/feature/workflow/services/database-queries'
import { Store } from '@/core/feature/workflow/services/store'
import type { StoreService } from '@/core/feature/workflow/services/store'

class D1FixtureFailure extends Data.TaggedError('D1FixtureFailure')<{ cause: unknown; message: string }> {}

const native = <A>(operation: string, evaluate: () => Promise<A>): Effect.Effect<A, D1FixtureFailure> =>
  Effect.tryPromise({
    catch: (cause) => new D1FixtureFailure({ cause, message: operation }),
    try: evaluate,
  })

const openDatabase = Effect.acquireRelease(
  Effect.sync(
    () =>
      new Miniflare({
        compatibilityDate: '2026-07-30',
        d1Databases: { DB: 'flowdeck-test', OTHER: 'flowdeck-other-test' },
        modules: true,
        script: 'export default {}',
      }),
  ),
  (miniflare) => Effect.promise(async () => miniflare.dispose()),
)

const migrate = Effect.fn('flowdeck.test.migrateD1')(function* (database: D1Database) {
  const migrations = yield* native('Read D1 test migrations', async () => readD1Migrations('migrations'))
  const queries = Array.flatMap(migrations, (migration) => migration.queries)
  const statements = Array.map(queries, (query) => database.prepare(query))
  yield* native('Apply D1 test migrations', async () => database.batch(statements))
})

const storeServices = (database: D1Database): Layer.Layer<DatabaseQueries> =>
  DatabaseQueriesLive.pipe(
    Layer.provide(AlchemyQueryExecutorLive),
    Layer.provide(NativeD1Client),
    Layer.provide(Layer.succeed(D1Binding, database)),
  )

type D1Services = Readonly<{
  freshQueries: Effect.Effect<typeof DatabaseQueries.Service>
  freshStore: Effect.Effect<StoreService>
}>

const fixtureServices = (database: D1Database): D1Services => {
  const QueriesLive = storeServices(database)
  const StoreLive = D1StoreLive.pipe(Layer.provide(QueriesLive))
  return {
    freshQueries: DatabaseQueries.pipe(Effect.provide(QueriesLive)),
    freshStore: Store.pipe(Effect.provide(StoreLive)),
  }
}

export const openD1WorkflowTestDatabase = Effect.gen(function* () {
  const miniflare = yield* openDatabase
  const database = yield* native('Open the primary test D1 database', async () => miniflare.getD1Database('DB'))
  yield* migrate(database)
  return { database, miniflare, services: fixtureServices(database) }
})
