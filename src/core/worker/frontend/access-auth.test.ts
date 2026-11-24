import { ConfigProvider, Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { authorizeAccess } from './access-auth.ts'
import { accessPolicyId, frontendHostname } from './access.ts'
import { accessAudienceFromEnvironment } from './assembly.ts'

const production = { aud: 'flowdeck-audience' }
const admitted = (aud = 'flowdeck-audience') => Effect.succeed({ aud })

describe('frontend Access admission', () => {
  test('decodes the native audience at the request assembly boundary', async () => {
    await expect(
      Effect.runPromise(accessAudienceFromEnvironment({ FLOWDECK_ACCESS_AUD: 'flowdeck-audience' })),
    ).resolves.toStrictEqual(production)
  })

  test('trusts native admission from the expected Access application', async () => {
    await expect(Effect.runPromise(authorizeAccess(production, admitted()))).resolves.toBeUndefined()
  })

  test('rejects requests without native Access admission', async () => {
    await expect(Effect.runPromise(authorizeAccess(production, Effect.succeed(undefined)))).rejects.toMatchObject({
      _tag: 'AccessDenied',
      status: 401,
    })
  })

  test('rejects admission from another Access application', async () => {
    await expect(Effect.runPromise(authorizeAccess(production, admitted('other-audience')))).rejects.toMatchObject({
      _tag: 'AccessDenied',
      status: 403,
    })
  })

  test('does not fetch or revalidate a trusted identity', async () => {
    const admission = Effect.succeed({
      aud: 'flowdeck-audience',
      getIdentity: () => Effect.die('Identity lookup is unnecessary for native admission.'),
    })
    await expect(Effect.runPromise(authorizeAccess(production, admission))).resolves.toBeUndefined()
  })

  test.each([{}, { FLOWDECK_ACCESS_AUD: '' }, { FLOWDECK_ACCESS_AUD: 42 }])(
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
  test('uses the single approved public hostname', () => {
    expect(frontendHostname).toBe('flowdeck.totto2727.dev')
  })

  test('accepts the existing Pulumi-managed policy identity', async () => {
    const provider = ConfigProvider.fromUnknown({
      FLOWDECK_ACCESS_POLICY_ID: '00000000-0000-4000-8000-000000000001',
    })
    await expect(Effect.runPromise(accessPolicyId.parse(provider))).resolves.toBe(
      '00000000-0000-4000-8000-000000000001',
    )
  })

  test.each(['', '*', 'iac-prod-must-authenticate-with-saml', 'not-a-uuid'])(
    'rejects an invalid existing policy identity: %j',
    async (value) => {
      const provider = ConfigProvider.fromUnknown({ FLOWDECK_ACCESS_POLICY_ID: value })
      await expect(Effect.runPromise(accessPolicyId.parse(provider))).rejects.toMatchObject({ _tag: 'ConfigError' })
    },
  )

  test('requires an existing policy rather than creating a fallback', async () => {
    await expect(Effect.runPromise(accessPolicyId.parse(ConfigProvider.fromUnknown({})))).rejects.toMatchObject({
      _tag: 'ConfigError',
    })
  })
})
