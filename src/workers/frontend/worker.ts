import { Effect } from 'effect'

import { DeploymentLayer } from '../composition'
import { Frontend } from '../definitions'
import FrontendLive from './index'

/** The Effront runtime evaluates only its own Worker implementation. */
export default Frontend.pipe(Effect.provide(FrontendLive), Effect.provide(DeploymentLayer))
