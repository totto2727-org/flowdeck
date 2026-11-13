import { Container } from 'alchemy/Cloudflare/Containers'
import { Config, Effect, Option } from 'effect'

export class PiContainer extends Container<PiContainer>()(
  // Preserve both the deployed resource identity and its ctx.container.images key.
  'JcodeSandbox',
  Effect.gen(function* () {
    const image = yield* Config.String('FLOWDECK_WORKSPACE_IMAGE').pipe(Config.option)
    if (Option.isSome(image)) return { schedulingPolicy: 'durable_object' as const, image: image.value }
    const dockerfile = yield* Config.String('FLOWDECK_PI_DOCKERFILE').pipe(Config.withDefault('sandbox/Dockerfile'))
    return { schedulingPolicy: 'durable_object' as const, context: 'sandbox', dockerfile }
  }),
) {}
