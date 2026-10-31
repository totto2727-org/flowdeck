import { Effect } from 'effect'

import type { RegisteredWorkflow } from '../../../features/workflow/services/workflow-definition'
import { demoDefinition } from '../../demo-workflow/features/definition'
import { developmentDefinition } from '../../development-workflow/features/definition'
import { DevelopmentWorkflowBinding, WorkflowBinding } from './workflow-binding'

/** The only composition feature that knows which workflow applications are installed. */
export const makeWorkflowRegistry = Effect.gen(function* () {
  return [
    { ...demoDefinition, binding: yield* WorkflowBinding },
    { ...developmentDefinition, binding: yield* DevelopmentWorkflowBinding },
  ] satisfies ReadonlyArray<RegisteredWorkflow>
})
