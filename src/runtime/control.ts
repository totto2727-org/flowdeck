import * as BrowserCrypto from '@effect/platform-browser/BrowserCrypto'
import { QueryDatabase, QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { makeRpcStub, Worker, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'

import { ApiRoutes } from '../api/router'
import { makeD1Store } from '../services/d1-store'
import { Store } from '../services/store'
import { WorkflowBinding } from '../services/workflow-binding'
import { Database } from './database'

/** The service binding is registered once, statically, during Worker construction. */
export default class Control extends Worker<Control>()(
  'Control',
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4381, strictPort: true },
      env: { WORKFLOW: yield* Worker.ref('DemoWorkflow') },
    }
  }),
  Effect.gen(function* () {
    const database = yield* QueryDatabase(yield* Database)
    // A symbolic ref binds the foreign Worker without initializing its DO runtime here.
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
) {}
