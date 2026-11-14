import { Layer } from 'effect'

import WorkflowLive from '@/bridge/workflow/bridge/worker'
import ControlLive from '@/core/worker/control/control'
import { LocalSecurity, ProductionSecurity } from '@/core/worker/frontend/access'
import FrontendLive from '@/core/worker/frontend/frontend'
import DemoWorkflowLive from '@/user-land/workflow/demo/worker'
import DevelopmentWorkflowLive from '@/user-land/workflow/development/worker'

/** Assemble the complete application graph once, in static binding dependency order. */
const ApplicationLive = FrontendLive.pipe(
  Layer.provideMerge(
    ControlLive.pipe(
      Layer.provideMerge(
        WorkflowLive.pipe(Layer.provideMerge(Layer.mergeAll(DemoWorkflowLive, DevelopmentWorkflowLive))),
      ),
    ),
  ),
)

export const DevelopmentLayer = ApplicationLive.pipe(Layer.provide(LocalSecurity))
export const ProductionLayer = ApplicationLive.pipe(Layer.provide(ProductionSecurity))
