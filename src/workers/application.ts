import { Layer } from 'effect'

import ControlLive from './control/control'
import DemoWorkflowLive from './demo-workflow/demo-workflow'
import { LocalSecurity, ProductionSecurity } from './frontend/access'
import FrontendLive from './frontend/frontend'
import WorkflowLive from './workflow'

/** Assemble the complete application graph once, in static binding dependency order. */
const ApplicationLive = FrontendLive.pipe(
  Layer.provideMerge(ControlLive.pipe(Layer.provideMerge(WorkflowLive.pipe(Layer.provideMerge(DemoWorkflowLive))))),
)

export const DevelopmentLayer = ApplicationLive.pipe(Layer.provide(LocalSecurity))
export const ProductionLayer = ApplicationLive.pipe(Layer.provide(ProductionSecurity))
