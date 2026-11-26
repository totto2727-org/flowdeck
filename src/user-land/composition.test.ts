import { live } from '@effect/vitest'
import { ConfigProvider, Effect, Function } from 'effect'
import { describe, expect } from 'vite-plus/test'

import { developmentAccess, FrontendSecurity, LocalSecurity, RuntimeSecurity } from '@/core/worker/frontend/access'
import { authorizeAccess } from '@/core/worker/frontend/access-auth'
import { accessAudienceFromEnvironment } from '@/core/worker/frontend/assembly'
import { HttpStatus } from '@/share/feature/http/status'

import { applicationMode } from './composition.ts'

const selectedApplication = (
  values: Record<string, string>,
): Effect.Effect<Effect.Success<typeof applicationMode>, Effect.Error<typeof applicationMode>> => {
  const provider = ConfigProvider.fromUnknown(values)
  return applicationMode.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
}

describe('final application composition', () => {
  live('selects development application mode at the composition boundary', () =>
    Effect.gen(function* () {
      expect(yield* selectedApplication({ ALCHEMY_DEV: 'true' })).toBe('development')
    }),
  )

  live('selects production application mode by default', () =>
    Effect.gen(function* () {
      expect(yield* selectedApplication({})).toBe('production')
      expect(yield* selectedApplication({ ALCHEMY_DEV: 'false' })).toBe('production')
    }),
  )

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
      const absent = Effect.sync(Function.constUndefined)
      const denied = yield* authorizeAccess(expected, absent).pipe(Effect.flip)
      expect(denied).toHaveProperty('_tag', 'AccessDenied')
      expect(denied).toHaveProperty('status', HttpStatus.unauthorized)
    }),
  )

  live('provides no deployment resource props at the fixed runtime capture boundary', () =>
    Effect.gen(function* () {
      expect(yield* FrontendSecurity.pipe(Effect.provide(RuntimeSecurity))).toStrictEqual({})
    }),
  )
})
