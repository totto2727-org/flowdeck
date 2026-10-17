import { Worker, type WorkerServices } from 'alchemy/Cloudflare/Workers'
import type { HttpEffect } from 'alchemy/Http'
import type { RuntimeContext } from 'alchemy/RuntimeContext'

import type { WorkflowBinding } from './control/features/workflow-binding'

/** Lightweight identities and contracts shared by implementations and static bindings. */
export class Frontend extends Worker<Frontend, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Frontend',
) {}
export class Control extends Worker<Control, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Control',
) {}
export class DemoWorkflow extends Worker<DemoWorkflow, WorkflowBinding['Service']>()('DemoWorkflow') {}
export class DevelopmentWorkflow extends Worker<DevelopmentWorkflow, WorkflowBinding['Service']>()(
  'DevelopmentWorkflow',
) {}
