import { BrowserCrypto } from '@effect/platform-browser'
import reylo from '@totto2727/reylo/vite'
import { Config, Effect, Layer } from 'effect'

import { workspaceProxyBuild } from '@/core/worker/pi/feature/workspace-proxy-build'

import { DevelopmentWorkflow } from './definition.ts'
import { forwardDevelopmentRun } from './forward-run.ts'
import { DevelopmentRunLive } from './run.ts'

const services = Layer.mergeAll(DevelopmentRunLive, BrowserCrypto.layer)
const entry = forwardDevelopmentRun.pipe(Effect.provide(services))

// oxlint-disable-next-line import/no-default-export -- Alchemy consumes the default workflow Worker entry for this bundle.
export default DevelopmentWorkflow.make(
  {
    build: { input: { plugins: [reylo(), workspaceProxyBuild()] } },
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    dev: { host: '127.0.0.1', port: 4383, strictPort: true },
    env: {
      CLOUDFLARE_ACCOUNT_ID: Config.String('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_AI_GATEWAY_API_KEY: Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY'),
      CLOUDFLARE_AI_GATEWAY_ID: Config.String('CLOUDFLARE_AI_GATEWAY_ID'),
    },
    main: import.meta.url,
    workersDev: { enabled: false, previewsEnabled: false },
  },
  entry,
)
