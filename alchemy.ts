import { Effect } from 'effect'

import { DeploymentLayer } from './src/workers/composition'
import ControlLive from './src/workers/control'
import { Control, DemoWorkflow, DevelopmentWorkflow, Frontend, Inference } from './src/workers/definitions'
import DemoWorkflowLive from './src/workers/demo-workflow'
import DevelopmentWorkflowLive from './src/workers/development-workflow'
import FrontendLive from './src/workers/frontend'
import InferenceLive from './src/workers/inference'

export { Database } from './src/workers/database'
export { Control, DemoWorkflow, DevelopmentWorkflow, Frontend, Inference }

export const WorkerResources = Effect.gen(function* () {
  const inference = yield* Inference.pipe(Effect.provide(InferenceLive))
  const workflow = yield* DemoWorkflow.pipe(Effect.provide(DemoWorkflowLive))
  const development = yield* DevelopmentWorkflow.pipe(Effect.provide(DevelopmentWorkflowLive))
  const control = yield* Control.pipe(Effect.provide(ControlLive))
  const frontend = yield* Frontend.pipe(Effect.provide(FrontendLive))
  return { workflow, development, control, frontend, inference }
}).pipe(Effect.provide(DeploymentLayer))

export { default } from './src/workers/frontend/worker'
