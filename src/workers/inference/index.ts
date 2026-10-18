import { Config, Effect } from 'effect'
import { FetchHttpClient, HttpRouter } from 'effect/http'

import { Inference } from '../definitions'
import { makeGatewayTransport } from './features/gateway-transport'
import { inferenceRoutes } from './features/inference'

/** This private Worker alone authenticates to the existing gateway. Pi and its Container receive no key. */
export default Inference.make(
  {
    main: import.meta.url,
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    workersDev: { enabled: false, previewsEnabled: false },
    dev: { host: '127.0.0.1', port: 4384, strictPort: true },
  },
  Effect.gen(function* () {
    const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID')
    const gatewayId = yield* Config.String('CLOUDFLARE_AI_GATEWAY_ID')
    const apiKey = yield* Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY')
    const model = yield* Config.String('FLOWDECK_PI_MODEL').pipe(
      Config.withDefault('custom-opencode-go/deepseek-v4.1-flash'),
    )
    const infer = yield* makeGatewayTransport({ accountId, gatewayId, apiKey })
    const routes = inferenceRoutes(model, infer)
    return {
      fetch: HttpRouter.toHttpEffect(routes).pipe(Effect.flatten, Effect.orDie),
    }
  }).pipe(Effect.provide(FetchHttpClient.layer)),
)
