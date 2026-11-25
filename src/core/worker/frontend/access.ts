import type { Output } from 'alchemy'
import { Application } from 'alchemy/Cloudflare/Access'
import type { WorkerProps } from 'alchemy/Cloudflare/Workers'
import { Config, Context, Effect, Layer, Schema } from 'effect'

/** Reference the reusable SAML policy owned by monorepo/infra/cloudflare, never recreate its rules. */
export const accessPolicyId = Config.schema(Schema.String.check(Schema.isUUID()), 'FLOWDECK_ACCESS_POLICY_ID')

export const frontendHostname = 'flowdeck.totto2727.dev'

type AccessBindings = Readonly<{ FLOWDECK_ACCESS_AUD: string | Output<string> }>
export class FrontendSecurity extends Context.Service<
  FrontendSecurity,
  Pick<WorkerProps<AccessBindings>, 'domain' | 'access' | 'env' | 'dev'>
>()('flowdeck/FrontendSecurity') {}

/** No cloud resources or principal configuration are needed by these implementations. */
export const developmentAccess = {
  aud: 'flowdeck-development',
  identity: { email: 'developer@flowdeck.invalid' },
}

export const LocalSecurity = Layer.succeed(FrontendSecurity, {
  dev: { access: developmentAccess, host: '127.0.0.1', port: 4380, strictPort: true },
  env: {
    FLOWDECK_ACCESS_AUD: developmentAccess.aud,
  },
})
export const RuntimeSecurity = Layer.succeed(FrontendSecurity, {})

export const ProductionSecurity = Layer.effect(
  FrontendSecurity,
  Effect.gen(function* () {
    const policyId = yield* accessPolicyId
    const access = yield* Application('FrontendAccess', {
      appLauncherVisible: false,
      domain: frontendHostname,
      name: 'Flowdeck',
      policies: [{ id: policyId, precedence: 1 }],
      sessionDuration: '24h',
      type: 'self_hosted',
    })
    return {
      access,
      domain: { name: frontendHostname, previews: false },
      env: {
        FLOWDECK_ACCESS_AUD: access.aud,
      },
    }
  }),
)
