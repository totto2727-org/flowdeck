import { Stack } from 'alchemy'
import { providers, state as cloudflareState } from 'alchemy/Cloudflare'
import { Effect } from 'effect'

import { WorkerResources } from './alchemy'

/** Infrastructure state is shared through the official Cloudflare backend. */
export default Stack(
  'flowdeck',
  { state: cloudflareState(), providers: providers() },
  WorkerResources.pipe(Effect.map(({ frontend }) => ({ frontend: frontend.url }))),
)
