import { Context } from 'effect'
import type { Effect } from 'effect'

import type { makeDevelopmentSdk } from './sdk-runtime'

/** Runtime service identity stays safe to import during Node-side provisioning. */
export class DevelopmentSdk extends Context.Service<DevelopmentSdk, Effect.Success<typeof makeDevelopmentSdk>>()(
  'flowdeck/DevelopmentSdk',
) {}
