import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Predicate, Schema } from 'effect'

import { Control, Frontend } from '../definitions'
import { developmentAccess, FrontendSecurity } from './access'
import { authorizeFrontend } from './access-auth'
import { frontendAuthorization } from './features/authorization'
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
      dev: { host: '127.0.0.1', port: 4380, strictPort: true, access: developmentAccess },
      ...security,
      env: { ...security.env, CONTROL: yield* Control },
      vite: { rootDir: '.', viteEnvironments: { entry: 'rsc', children: ['ssr'] } },
    }
  }),
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const environment = yield* Schema.decodeUnknownEffect(ControlEnvironment)(yield* WorkerEnvironment)
      const worker = yield* makeWebWorker(environment.CONTROL)
      return yield* worker.fetch
    }).pipe(frontendAuthorization(authorizeFrontend), Effect.orDie),
  }),
)
