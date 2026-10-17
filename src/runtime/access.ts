import { ALCHEMY_DEV, ALCHEMY_PHASE, Stage } from 'alchemy'
import { Application } from 'alchemy/Cloudflare/Access'
import { Array, Config, Effect, Schema, String } from 'effect'

/** Exact identities only. Empty values, wildcards and domain-wide grants are rejected. */
export const accessEmails = Config.schema(
  Schema.String.check(
    Schema.isPattern(/^\s*[^@\s,*]+@[^@\s,*]+\.[^@\s,*]+(?:\s*,\s*[^@\s,*]+@[^@\s,*]+\.[^@\s,*]+)*\s*$/),
  ),
  'FLOWDECK_ACCESS_EMAILS',
).pipe(Config.map((value) => Array.dedupe(Array.map(String.split(value, ','), String.trim))))

export const frontendHostname = 'flowdeck.totto2727.dev'

/** No cloud Access resource, principal configuration or custom domain is loaded locally. */
export const frontendSecurity = Effect.gen(function* () {
  if ((yield* ALCHEMY_PHASE) === 'runtime') return { env: {} }
  if (yield* ALCHEMY_DEV) return { env: { FLOWDECK_LOCAL_DEV: true } }
  if ((yield* Stage) !== 'production') {
    return yield* Effect.die(new Error('Cloud configuration is available only for the production stage.'))
  }
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
})
