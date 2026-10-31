import { DurableObject, Worker } from 'alchemy/Cloudflare/Workers'
import { Config, Effect } from 'effect'
import reylo from 'reylo/vite'

import { Database } from '../database'
import { DevelopmentContainer } from './container'
import type { DevelopmentRun } from './worker'

/** External Worker props stay Node-safe. Alchemy bundles the native classes directly from worker.ts. */
export class DevelopmentWorkflow extends Worker<DevelopmentWorkflow>()(
  'DevelopmentWorkflow',
  Effect.gen(function* () {
    return {
      main: new URL('./worker.ts', import.meta.url).href,
      build: { input: { plugins: [reylo()] } },
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4383, strictPort: true },
      env: {
        DATABASE: yield* Database,
        DevelopmentRun: DurableObject<DevelopmentRun>('DevelopmentRun', {
          containers: [DevelopmentContainer],
        }),
        CLOUDFLARE_ACCOUNT_ID: Config.String('CLOUDFLARE_ACCOUNT_ID'),
        CLOUDFLARE_AI_GATEWAY_ID: Config.String('CLOUDFLARE_AI_GATEWAY_ID'),
        CLOUDFLARE_AI_GATEWAY_API_KEY: Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY'),
      },
    }
  }),
) {}

export default DevelopmentWorkflow
