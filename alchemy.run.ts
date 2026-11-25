import { ALCHEMY_DEV, localState, Stack } from 'alchemy'
import { providers, state as cloudflareState } from 'alchemy/Cloudflare'
import { Effect, Layer } from 'effect'

import { WorkerResources } from './alchemy.ts'

/** Select infrastructure state only at the deployment entry point. */
export const DeploymentState = Layer.unwrap(
  ALCHEMY_DEV.pipe(
    Effect.orDie,
    Effect.map((dev) => (dev ? localState() : cloudflareState())),
  ),
)

// oxlint-disable-next-line import/no-default-export -- The Alchemy CLI loads the default stack from this config file.
export default Stack(
  'flowdeck',
  { providers: providers(), state: DeploymentState },
  WorkerResources.pipe(Effect.map(({ frontend }) => ({ frontend: frontend.url }))),
)
