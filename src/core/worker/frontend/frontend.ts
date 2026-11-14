import { Effect } from 'effect'

import { Control } from '@/core/worker/control/definition'

import { FrontendSecurity } from './access'
import { frontendRequest, FrontendRequestLayer } from './assembly'
import { Frontend } from './definition'

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
    fetch: frontendRequest.pipe(Effect.provide(FrontendRequestLayer), Effect.orDie),
  }),
)
