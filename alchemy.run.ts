import { localState, Stack } from 'alchemy'
import { providers } from 'alchemy/Cloudflare'
import { Effect } from 'effect'

import { WorkerResources } from './alchemy'

/** Local state and no deployment task. The injected composition determines cloud resource declarations. */
export default Stack(
  'flowdeck',
  { state: localState(), providers: providers() },
  WorkerResources.pipe(Effect.map(({ control, frontend }) => ({ control: control.url, frontend: frontend.url }))),
)
