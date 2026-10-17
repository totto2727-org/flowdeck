import { Context, Effect } from 'effect'

import type { DomainError } from '../../../features/workflow/domain/errors'

/** The control worker statically provides the bundled demo workflow entry. */
export class WorkflowBinding extends Context.Service<
  WorkflowBinding,
  {
    readonly start: (runId: string) => Effect.Effect<void, DomainError>
    readonly resume: (runId: string) => Effect.Effect<void, DomainError>
  }
>()('flowdeck/WorkflowBinding') {}

/** A distinct static service binding, never a dynamic Worker reference. */
export class DevelopmentWorkflowBinding extends Context.Service<
  DevelopmentWorkflowBinding,
  WorkflowBinding['Service']
>()('flowdeck/DevelopmentWorkflowBinding') {}
