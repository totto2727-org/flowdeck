import { makeRpcStub, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'

import { Workflows } from '../../features/workflow/services/workflows'
import { Control, Workflow } from '../definitions'
import { ApiRoutes } from './features/router'

/** Control has one static workflow service binding and no per-workflow configuration. */
export default Control.make(
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4381, strictPort: true },
      env: { WORKFLOW: yield* Workflow },
    }
  }),
  Effect.sync(() => {
    const workflows = makeRpcStub<Workflows['Service']>(
      WorkerEnvironment.pipe(Effect.map((environment) => environment['WORKFLOW'])),
    )
    return {
      fetch: Effect.gen(function* () {
        const routes = ApiRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(Workflows, workflows)))
        const http = yield* HttpRouter.toHttpEffect(routes)
        return yield* http
      }).pipe(Effect.orDie),
    }
  }),
)
