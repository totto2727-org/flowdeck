import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { accessEmails, frontendHostname } from './access'
import { authorizeAccess } from './access-auth'

const production = {
  FLOWDECK_LOCAL_DEV: false,
  FLOWDECK_ACCESS_AUD: 'flowdeck-audience',
  FLOWDECK_ACCESS_EMAILS: ['operator@example.com'],
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

  it('rejects a native identity that is absent from the explicit allowlist', async () => {
    await expect(
      Effect.runPromise(authorizeAccess(production, admitted('stranger@example.com'))),
    ).rejects.toMatchObject({ _tag: 'AccessDenied', status: 403 })
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

  it('does not let a development flag bypass the Access implementation', async () => {
    await expect(
      Effect.runPromise(authorizeAccess({ ...production, FLOWDECK_LOCAL_DEV: true }, Effect.succeed(undefined))),
    ).rejects.toMatchObject({ _tag: 'AccessDenied', status: 401 })
  })

  it('does not treat a string-valued development flag as an authentication bypass', async () => {
    await expect(Effect.runPromise(authorizeAccess({ FLOWDECK_LOCAL_DEV: 'true' }, admitted()))).rejects.toMatchObject({
      _tag: 'AccessDenied',
      status: 503,
    })
  })
})

describe('production Access resource inputs', () => {
  it('uses the single approved public hostname', () => {
    expect(frontendHostname).toBe('flowdeck.totto2727.dev')
  })

  it('accepts and deduplicates only explicit email identities', async () => {
    const provider = ConfigProvider.fromUnknown({
      FLOWDECK_ACCESS_EMAILS: 'operator@example.com, operator@example.com, other@example.com',
    })
    await expect(Effect.runPromise(accessEmails.parse(provider))).resolves.toEqual([
      'operator@example.com',
      'other@example.com',
    ])
  })

  it.each(['', '*', '*@example.com', 'example.com', 'operator@example.com,', 'operator@example.com, *'])(
    'rejects a missing or broad identity grant: %j',
    async (value) => {
      const provider = ConfigProvider.fromUnknown({ FLOWDECK_ACCESS_EMAILS: value })
      await expect(Effect.runPromise(accessEmails.parse(provider))).rejects.toMatchObject({ _tag: 'ConfigError' })
    },
  )

  it('requires principals rather than falling back to allow-all', async () => {
    await expect(Effect.runPromise(accessEmails.parse(ConfigProvider.fromUnknown({})))).rejects.toMatchObject({
      _tag: 'ConfigError',
    })
  })
})
