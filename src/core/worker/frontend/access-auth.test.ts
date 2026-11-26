import { live } from '@effect/vitest'
import { ConfigProvider, Effect, Function } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { HttpStatus } from '@/share/feature/http/status'

import { authorizeAccess } from './access-auth.ts'
import type { AccessDenied } from './access-auth.ts'
import { accessPolicyId, frontendHostname } from './access.ts'
import { accessAudienceFromEnvironment } from './assembly.ts'

const production = { aud: 'flowdeck-audience' }
type TrustedAdmission = Effect.Effect<Readonly<{ aud: string }> | undefined>
const admitted = (aud = production.aud): TrustedAdmission => Effect.succeed({ aud })
const noAdmission = Effect.sync(Function.constUndefined)

const rejected = (admission: TrustedAdmission): Effect.Effect<AccessDenied, void> =>
  Effect.flip(authorizeAccess(production, admission))

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
      const error = yield* rejected(noAdmission)
      expect(error).toHaveProperty('_tag', 'AccessDenied')
      expect(error).toHaveProperty('status', HttpStatus.unauthorized)
    }),
  )

  live('rejects admission from another Access application', () =>
    Effect.gen(function* () {
      const error = yield* rejected(admitted('other-audience'))
      expect(error).toHaveProperty('_tag', 'AccessDenied')
      expect(error).toHaveProperty('status', HttpStatus.forbidden)
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
})

describe('frontend Access environment', () => {
  const invalidAudience = 42
  live.each([{}, { FLOWDECK_ACCESS_AUD: '' }, { FLOWDECK_ACCESS_AUD: invalidAudience }])(
    'fails closed when application configuration is missing or invalid: %j',
    (environment) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(accessAudienceFromEnvironment(environment))
        expect(error).toHaveProperty('_tag', 'AccessDenied')
        expect(error).toHaveProperty('status', HttpStatus.serviceUnavailable)
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
        const error = yield* Effect.flip(accessPolicyId.parse(provider))
        expect(error).toHaveProperty('_tag', 'ConfigError')
      }),
  )

  live('requires an existing policy rather than creating a fallback', () =>
    Effect.gen(function* () {
      const provider = ConfigProvider.fromUnknown({})
      const error = yield* Effect.flip(accessPolicyId.parse(provider))
      expect(error).toHaveProperty('_tag', 'ConfigError')
    }),
  )
})
