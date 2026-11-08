import { Effect } from 'effect'

import type { RegisteredWorkflow } from '@/features/workflow/services/workflow-definition'
import { demoDefinition } from '@/workers/demo-workflow/features/definition'
import { developmentDefinition } from '@/workers/development-workflow/features/definition'

import { DevelopmentWorkflowBinding, WorkflowBinding } from './workflow-binding'

/** The only composition feature that knows which workflow applications are installed. */
export const makeWorkflowRegistry = Effect.gen(function* () {
  return [
    { ...demoDefinition, binding: yield* WorkflowBinding },
    { ...developmentDefinition, binding: yield* DevelopmentWorkflowBinding },
  ] satisfies ReadonlyArray<RegisteredWorkflow>
})
