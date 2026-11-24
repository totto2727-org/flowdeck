import { live } from '@effect/vitest'
import { ConfigProvider, Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { authorizeAccess } from './access-auth.ts'
import { accessPolicyId, frontendHostname } from './access.ts'
import { accessAudienceFromEnvironment } from './assembly.ts'

const production = { aud: 'flowdeck-audience' }
const admitted = (aud = 'flowdeck-audience') => Effect.succeed({ aud })

describe('frontend Access admission', () => {
  live('decodes the native audience at the request assembly boundary', () =>
    Effect.gen(function* () {
      expect(yield* accessAudienceFromEnvironment({ FLOWDECK_ACCESS_AUD: 'flowdeck-audience' })).toStrictEqual(
        production,
      )
    }),
  )

  live('trusts native admission from the expected Access application', () =>
    Effect.gen(function* () {
      expect(yield* authorizeAccess(production, admitted())).toBeUndefined()
    }),
  )

  live('rejects requests without native Access admission', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(authorizeAccess(production, Effect.succeed(undefined)))).toMatchObject({
        _tag: 'AccessDenied',
        status: 401,
      })
    }),
  )

  live('rejects admission from another Access application', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(authorizeAccess(production, admitted('other-audience')))).toMatchObject({
        _tag: 'AccessDenied',
        status: 403,
      })
    }),
  )

  live('does not fetch or revalidate a trusted identity', () =>
    Effect.gen(function* () {
      const admission = Effect.succeed({
        aud: 'flowdeck-audience',
        getIdentity: () => Effect.die('Identity lookup is unnecessary for native admission.'),
      })
      expect(yield* authorizeAccess(production, admission)).toBeUndefined()
    }),
  )

  live.each([{}, { FLOWDECK_ACCESS_AUD: '' }, { FLOWDECK_ACCESS_AUD: 42 }])(
    'fails closed when application configuration is missing or invalid: %j',
    (environment) =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(accessAudienceFromEnvironment(environment))).toMatchObject({
          _tag: 'AccessDenied',
          status: 503,
        })
      }),
  )
})

describe('production Access resource inputs', () => {
  test('uses the single approved public hostname', () => {
    expect(frontendHostname).toBe('flowdeck.totto2727.dev')
  })

  live('accepts the existing Pulumi-managed policy identity', () =>
    Effect.gen(function* () {
      const provider = ConfigProvider.fromUnknown({
        FLOWDECK_ACCESS_POLICY_ID: '00000000-0000-4000-8000-000000000001',
      })
      expect(yield* accessPolicyId.parse(provider)).toBe('00000000-0000-4000-8000-000000000001')
    }),
  )

  live.each(['', '*', 'iac-prod-must-authenticate-with-saml', 'not-a-uuid'])(
    'rejects an invalid existing policy identity: %j',
    (value) =>
      Effect.gen(function* () {
        const provider = ConfigProvider.fromUnknown({ FLOWDECK_ACCESS_POLICY_ID: value })
        expect(yield* Effect.flip(accessPolicyId.parse(provider))).toMatchObject({ _tag: 'ConfigError' })
      }),
  )

  live('requires an existing policy rather than creating a fallback', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(accessPolicyId.parse(ConfigProvider.fromUnknown({})))).toMatchObject({
        _tag: 'ConfigError',
      })
    }),
  )
})
