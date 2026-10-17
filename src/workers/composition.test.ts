import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { deploymentDependencies, FrontendAuthorizationLayer } from './composition'
import { FrontendSecurity, LocalSecurity, ProductionSecurity, RuntimeSecurity } from './frontend/access'
import { AccessAuthorization, FrontendAuthorization, LocalAuthorization } from './frontend/access-auth'

const accessPolicy = Effect.runSync(FrontendAuthorization.pipe(Effect.provide(AccessAuthorization)))
const localPolicy = Effect.runSync(FrontendAuthorization.pipe(Effect.provide(LocalAuthorization)))

const injectedAuthorization = (environment: Record<string, unknown>) =>
  Effect.runPromise(
    FrontendAuthorization.pipe(
      Effect.provide(FrontendAuthorizationLayer),
      Effect.provideService(WorkerEnvironment, environment),
    ),
  )

const selectedDeployment = (values: Record<string, string>) =>
  Effect.runPromise(
    deploymentDependencies.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
    ),
  )

describe('final dependency composition', () => {
  it('injects local authorization only for an explicit native boolean binding', async () => {
    expect((await injectedAuthorization({ FLOWDECK_LOCAL_DEV: true })).authorize).toBe(localPolicy.authorize)
  })

  it.each([{}, { FLOWDECK_LOCAL_DEV: false }, { FLOWDECK_LOCAL_DEV: 'true' }])(
    'injects Access authorization for every nonlocal binding: %j',
    async (environment) => {
      expect((await injectedAuthorization(environment)).authorize).toBe(accessPolicy.authorize)
    },
  )

  it('does not retain a local authorization dependency across separate requests', async () => {
    expect((await injectedAuthorization({ FLOWDECK_LOCAL_DEV: true })).authorize).toBe(localPolicy.authorize)
    expect((await injectedAuthorization({})).authorize).toBe(accessPolicy.authorize)
  })

  it('selects local dependencies without requiring production principals', async () => {
    expect(await selectedDeployment({ ALCHEMY_PHASE: 'plan', ALCHEMY_DEV: 'true' })).toBe(LocalSecurity)
    await expect(Effect.runPromise(FrontendSecurity.pipe(Effect.provide(LocalSecurity)))).resolves.toEqual({
      env: { FLOWDECK_LOCAL_DEV: true },
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
