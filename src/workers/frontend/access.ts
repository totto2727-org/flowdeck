import { Application } from 'alchemy/Cloudflare/Access'
import type { WorkerProps } from 'alchemy/Cloudflare/Workers'
import { Array, Config, Context, Effect, Layer, Schema, String } from 'effect'

/** Exact identities only. Empty values, wildcards and domain-wide grants are rejected. */
export const accessEmails = Config.schema(
  Schema.String.check(
    Schema.isPattern(/^\s*[^@\s,*]+@[^@\s,*]+\.[^@\s,*]+(?:\s*,\s*[^@\s,*]+@[^@\s,*]+\.[^@\s,*]+)*\s*$/),
  ),
  'FLOWDECK_ACCESS_EMAILS',
).pipe(Config.map((value) => Array.dedupe(Array.map(String.split(value, ','), String.trim))))

export const frontendHostname = 'flowdeck.totto2727.dev'

export class FrontendSecurity extends Context.Service<
  FrontendSecurity,
  Pick<WorkerProps, 'domain' | 'access' | 'env'>
>()('flowdeck/FrontendSecurity') {}

/** No cloud resources or principal configuration are needed by these implementations. */
export const LocalSecurity = Layer.succeed(FrontendSecurity, { env: { FLOWDECK_LOCAL_DEV: true } })
export const RuntimeSecurity = Layer.succeed(FrontendSecurity, {})

export const ProductionSecurity = Layer.effect(
  FrontendSecurity,
  Effect.gen(function* () {
    const emails = yield* accessEmails
    const access = yield* Application('FrontendAccess', {
      type: 'self_hosted',
      name: 'Flowdeck',
      domain: frontendHostname,
      sessionDuration: '24h',
      appLauncherVisible: false,
      policies: [
        {
          name: 'Explicit Flowdeck identities',
          decision: 'allow',
          include: Array.map(emails, (email) => ({ email: { email } })),
        },
      ],
    })
    return {
      domain: { name: frontendHostname, previews: false },
      access,
      env: {
        FLOWDECK_LOCAL_DEV: false,
        FLOWDECK_ACCESS_AUD: access.aud,
        FLOWDECK_ACCESS_EMAILS: emails,
      },
    }
  }),
)
