import { Effect } from 'effect'

import { Workflow } from '@/bridge/workflow/core/definition'
import { Control } from '@/core/worker/control/definition'
import { Frontend } from '@/core/worker/frontend/definition'
import { DemoWorkflow } from '@/user-land/workflow/demo/definition'
import { DevelopmentWorkflow } from '@/user-land/workflow/development/definition'

import { ApplicationLayer } from './composition'

export { Database } from '@/core/worker/database'
export { Control, DemoWorkflow, DevelopmentWorkflow, Frontend, Workflow }

/** Installed application resources belong to user-land, not the deployment entry. */
export const WorkerResources = Effect.gen(function* () {
  const workflow = yield* DemoWorkflow
  const development = yield* DevelopmentWorkflow
  const workflows = yield* Workflow
  const control = yield* Control
  const frontend = yield* Frontend
  return { workflow, development, workflows, control, frontend }
}).pipe(Effect.provide(ApplicationLayer))
