import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Predicate, Schema } from 'effect'
import { HttpServerResponse } from 'effect/http'

import { FrontendAuthorizationLayer } from '../composition'
import { Control, Frontend } from '../definitions'
import { FrontendSecurity } from './access'
import { FrontendAuthorization } from './access-auth'
import { type ControlBinding, makeWebWorker } from './features/worker'

const ControlEnvironment = Schema.Struct({
  CONTROL: Schema.declare(
    (input): input is ControlBinding =>
      Predicate.isObject(input) && Predicate.hasProperty(input, 'fetch') && Predicate.isFunction(input.fetch),
  ),
})

/** A native binding is decoded and resolved only while a request is executing. */
export default Frontend.make(
  Effect.gen(function* () {
    const security = yield* FrontendSecurity
    return {
      main: import.meta.url,
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4380, strictPort: true },
      ...security,
      env: { ...security.env, CONTROL: yield* Control },
      vite: { rootDir: '.', viteEnvironments: { entry: 'rsc', children: ['ssr'] } },
    }
  }),
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const authorization = yield* FrontendAuthorization
      yield* authorization.authorize
      const environment = yield* Schema.decodeUnknownEffect(ControlEnvironment)(yield* WorkerEnvironment)
      const worker = yield* makeWebWorker(environment.CONTROL)
      return yield* worker.fetch
    }).pipe(
      Effect.provide(FrontendAuthorizationLayer),
      Effect.catchTag('AccessDenied', (error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: error.status })),
      ),
      Effect.orDie,
    ),
  }),
)
