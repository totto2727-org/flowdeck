import { Context } from 'effect'

import type { WorkflowExecutor } from '@/core/feature/workflow/services/workflow-definition'

// The integration Worker statically provides the development workflow entry.
export class DevelopmentWorkflowBinding extends Context.Service<DevelopmentWorkflowBinding, WorkflowExecutor>()(
  'flowdeck/DevelopmentWorkflowBinding',
) {}
