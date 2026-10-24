import { Effect } from 'effect'

import { DeploymentLayer } from './src/workers/composition'
import ControlLive from './src/workers/control'
import { Control, DemoWorkflow, Frontend, Workflow } from './src/workers/definitions'
import DemoWorkflowLive from './src/workers/demo-workflow'
import { DevelopmentWorkflow } from './src/workers/development-workflow'
import FrontendLive from './src/workers/frontend'
import WorkflowLive from './src/workers/workflow'

export { Database } from './src/workers/database'
export { Control, DemoWorkflow, DevelopmentWorkflow, Frontend, Workflow }

export const WorkerResources = Effect.gen(function* () {
  const workflow = yield* DemoWorkflow.pipe(Effect.provide(DemoWorkflowLive))
  const development = yield* DevelopmentWorkflow
  const workflows = yield* Workflow.pipe(Effect.provide(WorkflowLive))
  const control = yield* Control.pipe(Effect.provide(ControlLive))
  const frontend = yield* Frontend.pipe(Effect.provide(FrontendLive))
  return { workflow, development, workflows, control, frontend }
}).pipe(Effect.provide(DeploymentLayer))

export { default } from './src/workers/frontend/worker'
