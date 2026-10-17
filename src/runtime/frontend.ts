import { Worker, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Predicate, Schema } from 'effect'
import { HttpServerResponse } from 'effect/http'

import { type ControlBinding, makeWebWorker } from '../web/worker'
import { frontendSecurity } from './access'
import { authorizeFrontend } from './access-auth'

const ControlEnvironment = Schema.Struct({
  CONTROL: Schema.declare(
    (input): input is ControlBinding =>
      Predicate.isObject(input) && Predicate.hasProperty(input, 'fetch') && Predicate.isFunction(input.fetch),
  ),
})

/** A native binding is decoded and resolved only while a request is executing. */
export default class Frontend extends Worker<Frontend>()(
  'Frontend',
  Effect.gen(function* () {
    const security = yield* frontendSecurity
    return {
      main: import.meta.url,
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4380, strictPort: true },
      ...security,
      env: { ...security.env, CONTROL: yield* Worker.ref('Control') },
      vite: { rootDir: '.', viteEnvironments: { entry: 'rsc', children: ['ssr'] } },
    }
  }),
  Effect.succeed({
    fetch: Effect.gen(function* () {
      yield* authorizeFrontend
      const environment = yield* Schema.decodeUnknownEffect(ControlEnvironment)(yield* WorkerEnvironment)
      const worker = yield* makeWebWorker(environment.CONTROL)
      return yield* worker.fetch
    }).pipe(
      Effect.catchTag('AccessDenied', (error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: error.status })),
      ),
      Effect.orDie,
    ),
  }),
) {}
