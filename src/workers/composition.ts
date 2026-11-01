import { ALCHEMY_DEV, ALCHEMY_PHASE } from 'alchemy'
import { Effect, Layer } from 'effect'

import { LocalSecurity, ProductionSecurity, RuntimeSecurity } from './frontend/access'

/** Environment differences select dependencies only at the final composition boundary. */
export const deploymentDependencies = Effect.gen(function* () {
  if ((yield* ALCHEMY_PHASE) === 'runtime') return RuntimeSecurity
  return (yield* ALCHEMY_DEV) ? LocalSecurity : ProductionSecurity
})

export const DeploymentLayer = Layer.unwrap(deploymentDependencies)
