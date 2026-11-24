import { Effect } from 'effect'

import { Frontend } from './definition.ts'
import { FrontendRuntimeLayer } from './runtime-composition.ts'

/** The Effront runtime evaluates only its own Worker implementation. */
export default Frontend.pipe(Effect.provide(FrontendRuntimeLayer))
