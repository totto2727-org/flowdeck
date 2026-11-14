import { Context } from 'effect'
import type { Effect } from 'effect'

import type { makePiSdk } from './sdk-runtime'
import type { makeWorkerShellPiSdk } from './worker-shell-runtime'

/** Runtime service identity stays safe to import during Node-side provisioning. */
export class PiSdk extends Context.Service<PiSdk, Effect.Success<typeof makePiSdk>>()('flowdeck/PiSdk') {}

/** Separate identity keeps Container provisioning out of Worker-shell-only runtimes. */
export class PiWorkerShellSdk extends Context.Service<
  PiWorkerShellSdk,
  Effect.Success<ReturnType<typeof makeWorkerShellPiSdk>>
>()('flowdeck/PiWorkerShellSdk') {}
