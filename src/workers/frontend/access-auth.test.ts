import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { accessPolicyId, frontendHostname } from './access'
import { authorizeAccess, ExpectedAccessAudience } from './access-auth'
import { AccessAudienceBinding, accessAudienceFromEnvironment } from './assembly'

const production = { aud: 'flowdeck-audience' }
const admitted = (aud = 'flowdeck-audience') => Effect.succeed({ aud })

describe('frontend Access admission', () => {
  it('injects the decoded native audience through the request assembly Layer', async () => {
    await expect(
      Effect.runPromise(
        ExpectedAccessAudience.pipe(
          Effect.provide(AccessAudienceBinding),
          Effect.provideService(WorkerEnvironment, { FLOWDECK_ACCESS_AUD: 'flowdeck-audience' }),
        ),
      ),
    ).resolves.toEqual(production)
  })

  it('trusts native admission from the expected Access application', async () => {
    await expect(Effect.runPromise(authorizeAccess(production, admitted()))).resolves.toBeUndefined()
  })

  it('rejects requests without native Access admission', async () => {
    await expect(Effect.runPromise(authorizeAccess(production, Effect.succeed(undefined)))).rejects.toMatchObject({
      _tag: 'AccessDenied',
      status: 401,
    })
  })

  it('rejects admission from another Access application', async () => {
    await expect(Effect.runPromise(authorizeAccess(production, admitted('other-audience')))).rejects.toMatchObject({
      _tag: 'AccessDenied',
      status: 403,
    })
  })

  it('does not fetch or revalidate a trusted identity', async () => {
    const admission = Effect.succeed({
      aud: 'flowdeck-audience',
      getIdentity: () => Effect.die('Identity lookup is unnecessary for native admission.'),
    })
    await expect(Effect.runPromise(authorizeAccess(production, admission))).resolves.toBeUndefined()
  })

  it.each([{}, { FLOWDECK_ACCESS_AUD: '' }, { FLOWDECK_ACCESS_AUD: 42 }])(
    'fails closed when application configuration is missing or invalid: %j',
    async (environment) => {
      await expect(Effect.runPromise(accessAudienceFromEnvironment(environment))).rejects.toMatchObject({
        _tag: 'AccessDenied',
        status: 503,
      })
    },
  )
})

describe('production Access resource inputs', () => {
  it('uses the single approved public hostname', () => {
    expect(frontendHostname).toBe('flowdeck.totto2727.dev')
  })

  it('accepts the existing Pulumi-managed policy identity', async () => {
    const provider = ConfigProvider.fromUnknown({
      FLOWDECK_ACCESS_POLICY_ID: '00000000-0000-4000-8000-000000000001',
    })
    await expect(Effect.runPromise(accessPolicyId.parse(provider))).resolves.toBe(
      '00000000-0000-4000-8000-000000000001',
    )
  })

  it.each(['', '*', 'iac-prod-must-authenticate-with-saml', 'not-a-uuid'])(
    'rejects an invalid existing policy identity: %j',
    async (value) => {
      const provider = ConfigProvider.fromUnknown({ FLOWDECK_ACCESS_POLICY_ID: value })
      await expect(Effect.runPromise(accessPolicyId.parse(provider))).rejects.toMatchObject({ _tag: 'ConfigError' })
    },
  )

  it('requires an existing policy rather than creating a fallback', async () => {
    await expect(Effect.runPromise(accessPolicyId.parse(ConfigProvider.fromUnknown({})))).rejects.toMatchObject({
      _tag: 'ConfigError',
    })
  })
})
