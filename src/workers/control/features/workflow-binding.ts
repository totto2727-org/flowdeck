import { Context, Effect } from 'effect'

import type { DomainError } from '../../../features/workflow/domain/errors'

/** The control worker statically provides exactly the bundled demo workflow entry. */
export class WorkflowBinding extends Context.Service<
  WorkflowBinding,
  {
    readonly start: (runId: string) => Effect.Effect<void, DomainError>
    readonly resume: (runId: string) => Effect.Effect<void, DomainError>
  }
>()('flowdeck/WorkflowBinding') {}
