import { Context } from 'effect'

import type { WorkflowExecutor } from '../../../features/workflow/services/workflow-definition'

/** The integration Worker statically provides the bundled demo workflow entry. */
export class WorkflowBinding extends Context.Service<WorkflowBinding, WorkflowExecutor>()('flowdeck/WorkflowBinding') {}

/** A distinct static service binding, never a dynamic Worker reference. */
export class DevelopmentWorkflowBinding extends Context.Service<
  DevelopmentWorkflowBinding,
  WorkflowBinding['Service']
>()('flowdeck/DevelopmentWorkflowBinding') {}
