import { Effect } from 'effect'

import { Frontend } from './definition'
import { FrontendRuntimeLayer } from './runtime-composition'

/** The Effront runtime evaluates only its own Worker implementation. */
export default Frontend.pipe(Effect.provide(FrontendRuntimeLayer))
