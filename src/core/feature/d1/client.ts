import type { D1Result } from '@cloudflare/workers-types'
import type { PreparedStatement, QueryDatabaseClient } from 'alchemy/Cloudflare/D1'
import { Context, type Effect } from 'effect'

interface BoundD1Statement extends PreparedStatement {
  bind(...values: Parameters<PreparedStatement['bind']>): BoundD1Statement
  all<T = unknown>(): Effect.Effect<D1Result<T>>
}

interface BoundD1Client extends QueryDatabaseClient {
  prepare: (query: string) => BoundD1Statement
  batch: <T = unknown>(statements: PreparedStatement[]) => Effect.Effect<D1Result<T>[]>
}

export class D1Client extends Context.Service<D1Client, BoundD1Client>()('flowdeck/D1Client') {
  // Only use with QueryDatabaseBinding's captured WorkerEnvironment or the native
  // adapter's already resolved D1 binding. The installed Alchemy statement and
  // batch executors declare RuntimeContext but read only that captured resolver.
  // This construction-boundary override narrows those excess requirements without
  // supplying a fake Context or providing dependencies around individual queries.
  // QueryDatabaseBinding still reads its captured environment at execution time.
  // QueryDatabaseLocal and HTTP/deferred database-ID clients are NOT safe here:
  // their compatible SDK type does not prove execution is context-independent.
  static fromBinding = (client: QueryDatabaseClient): BoundD1Client => client as BoundD1Client
}
