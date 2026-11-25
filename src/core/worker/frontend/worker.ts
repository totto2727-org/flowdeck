import { Effect } from 'effect'

import { Frontend } from './definition.ts'
import { FrontendRuntimeLayer } from './runtime-composition.ts'

/** The Effront runtime evaluates only its own Worker implementation. */
// oxlint-disable-next-line import/no-default-export -- The Effront Worker adapter consumes the default Effect entry export.
export default Frontend.pipe(Effect.provide(FrontendRuntimeLayer))
