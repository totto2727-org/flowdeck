import { Effect } from 'effect'

import { Control } from '@/core/worker/control/definition'

import { FrontendSecurity } from './access.ts'
import { frontendRequest, FrontendRequestLayer } from './assembly.ts'
import { Frontend } from './definition.ts'

const fetch = frontendRequest.pipe(Effect.provide(FrontendRequestLayer), Effect.orDie)

/** A native binding is decoded and resolved only while a request is executing. */
// oxlint-disable-next-line import/no-default-export -- Alchemy discovers the Worker layer through this default entry export.
export default Frontend.make(
  Effect.gen(function* () {
    const security = yield* FrontendSecurity
    return {
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      dev: { host: '127.0.0.1', port: 4380, strictPort: true },
      ...security,
      env: { ...security.env, CONTROL: yield* Control },
      main: import.meta.url,
      vite: { rootDir: '.', viteEnvironments: { children: ['ssr'], entry: 'rsc' } },
      workersDev: { enabled: false, previewsEnabled: false },
    }
  }),
  Effect.succeed({ fetch }),
)
