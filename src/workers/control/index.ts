import * as BrowserCrypto from '@effect/platform-browser/BrowserCrypto'
import { QueryDatabase, QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { makeRpcStub, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'

import { makeD1Store } from '../../features/workflow/services/d1-store'
import { Store } from '../../features/workflow/services/store'
import { Database } from '../database'
import { Control, DemoWorkflow } from '../definitions'
import { ApiRoutes } from './features/router'
import { WorkflowBinding } from './features/workflow-binding'

/** The service binding is registered once, statically, during Worker construction. */
export default Control.make(
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4381, strictPort: true },
      env: { WORKFLOW: yield* DemoWorkflow },
    }
  }),
  Effect.gen(function* () {
    const database = yield* QueryDatabase(yield* Database)
    // The shared identity binds the foreign Worker without importing its implementation.
    const workflow = makeRpcStub<WorkflowBinding['Service']>(
      WorkerEnvironment.pipe(Effect.map((environment) => environment['WORKFLOW'])),
    )
    return {
      fetch: Effect.gen(function* () {
        const store = makeD1Store(yield* database.raw)
        const routes = ApiRoutes.pipe(
          HttpRouter.provideRequest(
            Layer.mergeAll(BrowserCrypto.layer, Layer.succeed(Store, store), Layer.succeed(WorkflowBinding, workflow)),
          ),
        )
        const http = yield* HttpRouter.toHttpEffect(routes)
        return yield* http
      }).pipe(Effect.orDie),
    }
  }).pipe(Effect.provide(QueryDatabaseBinding)),
)
