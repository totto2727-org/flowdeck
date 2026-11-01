import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { accessPolicyId, frontendHostname } from './access'
import { authorizeAccess } from './access-auth'

const production = {
  FLOWDECK_ACCESS_AUD: 'flowdeck-audience',
}

const admitted = (email = 'operator@example.com', aud = 'flowdeck-audience') =>
  Effect.succeed({
    aud,
    getIdentity: () => Effect.succeed({ email }),
  })

describe('frontend Access admission', () => {
  it('permits an exact configured identity admitted by the expected Access application', async () => {
    await expect(Effect.runPromise(authorizeAccess(production, admitted()))).resolves.toBeUndefined()
  })

  it('rejects requests without native Access admission', async () => {
    await expect(Effect.runPromise(authorizeAccess(production, Effect.succeed(undefined)))).rejects.toMatchObject({
      _tag: 'AccessDenied',
      status: 401,
    })
  })

  it('rejects an identity from another Access application', async () => {
    await expect(
      Effect.runPromise(authorizeAccess(production, admitted('operator@example.com', 'other-audience'))),
    ).rejects.toMatchObject({ _tag: 'AccessDenied', status: 403 })
  })

  it('trusts identities admitted by the configured Access policy without a second email allowlist', async () => {
    await expect(
      Effect.runPromise(authorizeAccess(production, admitted('stranger@example.com'))),
    ).resolves.toBeUndefined()
  })

  it.each([undefined, {}, { email: undefined }, { email: null }, { email: 42 }])(
    'rejects admission without a valid identity email: %j',
    async (identity) => {
      await expect(
        Effect.runPromise(
          authorizeAccess(
            production,
            Effect.succeed({
              aud: 'flowdeck-audience',
              getIdentity: () => Effect.succeed(identity),
            }),
          ),
        ),
      ).rejects.toMatchObject({ _tag: 'AccessDenied', status: 403 })
    },
  )

  it('reports an unavailable identity service without admitting the caller', async () => {
    await expect(
      Effect.runPromise(
        authorizeAccess(
          production,
          Effect.succeed({
            aud: 'flowdeck-audience',
            getIdentity: () => Effect.fail(new Error('Identity service unavailable')),
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'AccessDenied', status: 503 })
  })

  it('fails closed when runtime Access configuration is missing', async () => {
    await expect(Effect.runPromise(authorizeAccess({}, admitted()))).rejects.toMatchObject({
      _tag: 'AccessDenied',
      status: 503,
    })
  })
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

  it.each(['', '*', '*@example.com', 'example.com', 'operator@example.com,', 'operator@example.com, *'])(
    'rejects a missing or broad identity grant: %j',
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
