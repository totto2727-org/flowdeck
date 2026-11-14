import { ALCHEMY_DEV, localState, Stack } from 'alchemy'
import { providers, state as cloudflareState } from 'alchemy/Cloudflare'
import { Effect, Layer } from 'effect'

import { WorkerResources } from './alchemy'

/** Select infrastructure state only at the deployment entry point. */
export const DeploymentState = Layer.unwrap(
  ALCHEMY_DEV.pipe(
    Effect.orDie,
    Effect.map((dev) => (dev ? localState() : cloudflareState())),
  ),
)

export default Stack(
  'flowdeck',
  { state: DeploymentState, providers: providers() },
  WorkerResources.pipe(Effect.map(({ frontend }) => ({ frontend: frontend.url }))),
)
