import { Effect } from 'effect'

import type { RegisteredWorkflow } from '@/core/feature/workflow/services/workflow-definition'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'
import { developmentDefinition } from '@/user-land/workflow/development/feature/definition'

import { DevelopmentWorkflowBinding, WorkflowBinding } from './workflow-binding'

/** The only composition feature that knows which workflow applications are installed. */
export const makeWorkflowRegistry = Effect.gen(function* () {
  return [
    { ...demoDefinition, binding: yield* WorkflowBinding },
    { ...developmentDefinition, binding: yield* DevelopmentWorkflowBinding },
  ] satisfies ReadonlyArray<RegisteredWorkflow>
})
