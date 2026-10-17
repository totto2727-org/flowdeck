import { Effect } from 'effect'

import { DeploymentLayer } from './src/workers/composition'
import Control from './src/workers/control'
import DemoWorkflow from './src/workers/demo-workflow'
import Frontend from './src/workers/frontend'

export { Database } from './src/workers/database'
export { Control, DemoWorkflow, Frontend }

export const WorkerResources = Effect.gen(function* () {
  const workflow = yield* DemoWorkflow
  const control = yield* Control
  const frontend = yield* Frontend
  return { workflow, control, frontend }
}).pipe(Effect.provide(DeploymentLayer))

export default Frontend.pipe(Effect.provide(DeploymentLayer))
