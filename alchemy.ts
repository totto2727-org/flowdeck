import { Effect } from 'effect'

import Control from './src/runtime/control'
import DemoWorkflow from './src/runtime/demo-workflow'
import Frontend from './src/runtime/frontend'

export { Database } from './src/runtime/database'
export { Control, DemoWorkflow, Frontend }

export const WorkerResources = Effect.gen(function* () {
  const workflow = yield* DemoWorkflow
  const control = yield* Control
  const frontend = yield* Frontend
  return { workflow, control, frontend }
})

export default Frontend
