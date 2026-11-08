import { Effect } from 'effect'

import { Frontend } from '@/workers/definitions'
import { FrontendRuntimeLayer } from '@/workers/runtime-composition'

/** The Effront runtime evaluates only its own Worker implementation. */
export default Frontend.pipe(Effect.provide(FrontendRuntimeLayer))
