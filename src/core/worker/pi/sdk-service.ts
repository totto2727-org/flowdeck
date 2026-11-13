import { Context } from 'effect'
import type { Effect } from 'effect'

import type { makePiSdk } from './sdk-runtime'

/** Runtime service identity stays safe to import during Node-side provisioning. */
export class PiSdk extends Context.Service<PiSdk, Effect.Success<typeof makePiSdk>>()('flowdeck/PiSdk') {}
