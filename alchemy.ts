import { Effect } from 'effect'

import { ApplicationLayer } from './src/workers/composition'
import { Control, DemoWorkflow, Frontend, Workflow } from './src/workers/definitions'
import { DevelopmentWorkflow } from './src/workers/development-workflow/development-workflow'

export { Database } from './src/workers/database'
export { Control, DemoWorkflow, DevelopmentWorkflow, Frontend, Workflow }

export const WorkerResources = Effect.gen(function* () {
  const workflow = yield* DemoWorkflow
  const development = yield* DevelopmentWorkflow
  const workflows = yield* Workflow
  const control = yield* Control
  const frontend = yield* Frontend
  return { workflow, development, workflows, control, frontend }
}).pipe(Effect.provide(ApplicationLayer))

export { default } from './src/workers/frontend/worker'
