import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { deploymentDependencies } from './composition'
import {
  developmentAccess,
  FrontendSecurity,
  LocalSecurity,
  ProductionSecurity,
  RuntimeSecurity,
} from './frontend/access'
import { authorizeAccess } from './frontend/access-auth'

const selectedDeployment = (values: Record<string, string>) =>
  Effect.runPromise(
    deploymentDependencies.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
    ),
  )

describe('final dependency composition', () => {
  it('injects fixed local Access settings without bypassing authorization', async () => {
    expect(await selectedDeployment({ ALCHEMY_PHASE: 'plan', ALCHEMY_DEV: 'true' })).toBe(LocalSecurity)
    const security = await Effect.runPromise(FrontendSecurity.pipe(Effect.provide(LocalSecurity)))
    expect(security).toEqual({
      env: {
        FLOWDECK_ACCESS_AUD: developmentAccess.aud,
      },
    })
    await expect(
      Effect.runPromise(
        authorizeAccess(
          security.env,
          Effect.succeed({
            aud: developmentAccess.aud,
            getIdentity: () => Effect.succeed(developmentAccess.identity),
          }),
        ),
      ),
    ).resolves.toBeUndefined()
    await expect(Effect.runPromise(authorizeAccess(security.env, Effect.succeed(undefined)))).rejects.toMatchObject({
      _tag: 'AccessDenied',
      status: 401,
    })
  })

  it('selects runtime capture without requiring deployment inputs', async () => {
    expect(await selectedDeployment({ ALCHEMY_PHASE: 'runtime' })).toBe(RuntimeSecurity)
    await expect(Effect.runPromise(FrontendSecurity.pipe(Effect.provide(RuntimeSecurity)))).resolves.toEqual({})
  })

  it('selects production dependencies without falling back when principals are missing', async () => {
    expect(await selectedDeployment({ ALCHEMY_PHASE: 'plan', ALCHEMY_DEV: 'false' })).toBe(ProductionSecurity)
  })
})
