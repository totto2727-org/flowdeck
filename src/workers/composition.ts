import { ALCHEMY_DEV, ALCHEMY_PHASE } from 'alchemy'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer } from 'effect'

import { LocalSecurity, ProductionSecurity, RuntimeSecurity } from './frontend/access'
import { AccessAuthorization, LocalAuthorization } from './frontend/access-auth'

/** Environment differences select dependencies only at the final composition boundary. */
export const deploymentDependencies = Effect.gen(function* () {
  if ((yield* ALCHEMY_PHASE) === 'runtime') return RuntimeSecurity
  return (yield* ALCHEMY_DEV) ? LocalSecurity : ProductionSecurity
})

export const DeploymentLayer = Layer.unwrap(deploymentDependencies)

/** Native Worker bindings are trusted deployment inputs, never request headers or query values. */
export const FrontendAuthorizationLayer = Layer.unwrap(
  WorkerEnvironment.pipe(
    Effect.map((environment) =>
      environment['FLOWDECK_LOCAL_DEV'] === true ? LocalAuthorization : AccessAuthorization,
    ),
  ),
)
