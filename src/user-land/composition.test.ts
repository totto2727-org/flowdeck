import { live } from '@effect/vitest'
import { ConfigProvider, Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { developmentAccess, FrontendSecurity, LocalSecurity, RuntimeSecurity } from '@/core/worker/frontend/access'
import { authorizeAccess } from '@/core/worker/frontend/access-auth'
import { accessAudienceFromEnvironment } from '@/core/worker/frontend/assembly'

import { applicationMode } from './composition.ts'

const selectedApplication = (values: Record<string, string>): Promise<'development' | 'production'> =>
  Effect.runPromise(
    applicationMode.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))),
  )

describe('final application composition', () => {
  test('selects development application mode at the composition boundary', async () => {
    await expect(selectedApplication({ ALCHEMY_DEV: 'true' })).resolves.toBe('development')
  })

  test('selects production application mode by default', async () => {
    await expect(selectedApplication({})).resolves.toBe('production')
    await expect(selectedApplication({ ALCHEMY_DEV: 'false' })).resolves.toBe('production')
  })

  live('injects fixed local settings without bypassing the common authorization', () =>
    Effect.gen(function* () {
      const security = yield* FrontendSecurity.pipe(Effect.provide(LocalSecurity))
      expect(security.dev).toStrictEqual({
        access: developmentAccess,
        host: '127.0.0.1',
        port: 4380,
        strictPort: true,
      })
      const expected = yield* accessAudienceFromEnvironment(security.env)
      expect(expected).toStrictEqual({ aud: developmentAccess.aud })
      expect(yield* authorizeAccess(expected, Effect.succeed({ aud: developmentAccess.aud }))).toBeUndefined()
      expect(yield* Effect.flip(authorizeAccess(expected, Effect.succeed(undefined)))).toMatchObject({
        _tag: 'AccessDenied',
        status: 401,
      })
    }),
  )

  live('provides no deployment resource props at the fixed runtime capture boundary', () =>
    Effect.gen(function* () {
      expect(yield* FrontendSecurity.pipe(Effect.provide(RuntimeSecurity))).toStrictEqual({})
    }),
  )
})
