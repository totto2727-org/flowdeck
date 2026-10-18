import type { D1Database } from '@cloudflare/workers-types'
import { Container } from 'alchemy/Cloudflare/Containers'
import { Config, Effect, Option } from 'effect'

/** Native Worker bindings. Gateway credentials never enter the container launch environment. */
export interface DevelopmentEnvironment {
  DATABASE: D1Database
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_AI_GATEWAY_ID: string
  CLOUDFLARE_AI_GATEWAY_API_KEY: string
}

export class DevelopmentContainer extends Container<DevelopmentContainer>()(
  // Preserve both the deployed resource identity and its ctx.container.images key.
  'JcodeSandbox',
  Effect.gen(function* () {
    const image = yield* Config.String('FLOWDECK_WORKSPACE_IMAGE').pipe(Config.option)
    if (Option.isSome(image)) return { schedulingPolicy: 'durable_object' as const, image: image.value }
    const dockerfile = yield* Config.String('FLOWDECK_PI_DOCKERFILE').pipe(
      Config.withDefault('containers/workspace/Dockerfile'),
    )
    return { schedulingPolicy: 'durable_object' as const, context: 'containers/workspace', dockerfile }
  }),
) {}
