import { Effect } from 'effect'

import { Workflow } from '@/bridge/workflow/core/definition'
import { Control } from '@/core/worker/control/definition'
import { Frontend } from '@/core/worker/frontend/definition'
import { DemoWorkflow } from '@/user-land/workflow/demo/definition'
import { DevelopmentWorkflow } from '@/user-land/workflow/development/definition'

import { ApplicationLayer } from './composition.ts'

export { Workflow } from '@/bridge/workflow/core/definition'
export { Control } from '@/core/worker/control/definition'
export { Database } from '@/core/worker/database'
export { Frontend } from '@/core/worker/frontend/definition'
export { DemoWorkflow } from '@/user-land/workflow/demo/definition'
export { DevelopmentWorkflow } from '@/user-land/workflow/development/definition'

/** Installed application resources belong to user-land, not the deployment entry. */
export const WorkerResources = Effect.gen(function* () {
  const workflow = yield* DemoWorkflow
  const development = yield* DevelopmentWorkflow
  const workflows = yield* Workflow
  const control = yield* Control
  const frontend = yield* Frontend
  return { control, development, frontend, workflow, workflows }
}).pipe(Effect.provide(ApplicationLayer))
