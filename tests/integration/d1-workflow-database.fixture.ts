import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { Array, Data, Effect, Layer } from 'effect'
import { Miniflare } from 'miniflare'

import { D1Client } from '@/core/feature/d1/client'
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

export const nativeClientLayer = (database: D1Database): Layer.Layer<D1Client> => {
  const binding = Layer.succeed(D1Binding, database)
  return NativeD1Client.pipe(Layer.provide(binding))
}

export const clientForDatabase = (database: D1Database): Effect.Effect<typeof D1Client.Service> =>
  D1Client.pipe(Effect.provide(nativeClientLayer(database)))

export const databaseQueriesLayer = (client: Layer.Layer<D1Client>): Layer.Layer<DatabaseQueries> =>
  DatabaseQueriesLive.pipe(Layer.provide(AlchemyQueryExecutorLive), Layer.provide(client))

export const queriesWithClient = (client: typeof D1Client.Service): Effect.Effect<typeof DatabaseQueries.Service> => {
  const layer = Layer.succeed(D1Client, client)
  const queries = databaseQueriesLayer(layer)
  return DatabaseQueries.pipe(Effect.provide(queries))
}

export const storeWithClient = (client: Layer.Layer<D1Client>): Effect.Effect<StoreService> => {
  const queries = databaseQueriesLayer(client)
  const store = D1StoreLive.pipe(Layer.provide(queries))
  return Store.pipe(Effect.provide(store))
}

type D1Services = Readonly<{
  freshQueries: Effect.Effect<typeof DatabaseQueries.Service>
  freshStore: Effect.Effect<StoreService>
}>

const fixtureServices = (database: D1Database): D1Services => {
  const QueriesLive = databaseQueriesLayer(nativeClientLayer(database))
  const StoreLive = D1StoreLive.pipe(Layer.provide(QueriesLive))
  return {
    freshQueries: DatabaseQueries.pipe(Effect.provide(QueriesLive)),
    freshStore: Store.pipe(Effect.provide(StoreLive)),
  }
}

export const openFixtureBinding = Effect.fn('flowdeck.test.openD1Binding')(function* (
  miniflare: Miniflare,
  binding: 'DB' | 'OTHER',
) {
  const database = yield* native('Open test D1 binding', async () => miniflare.getD1Database(binding))
  yield* migrate(database)
  return database
})

export const openD1WorkflowTestDatabase = Effect.gen(function* () {
  const miniflare = yield* openDatabase
  const database = yield* openFixtureBinding(miniflare, 'DB')
  return { database, miniflare, services: fixtureServices(database) }
})
