import { Worker, type WorkerServices } from 'alchemy/Cloudflare/Workers'
import type { HttpEffect } from 'alchemy/Http'
import type { RuntimeContext } from 'alchemy/RuntimeContext'

import type { WorkflowService } from '../features/workflow/services/workflows'
import type { WorkflowBinding } from './workflow/features/workflow-binding'

/** Lightweight identities and contracts shared by implementations and static bindings. */
export class Frontend extends Worker<Frontend, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Frontend',
) {}
export class Control extends Worker<Control, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Control',
) {}
export class Workflow extends Worker<Workflow, WorkflowService<RuntimeContext>>()('Workflow') {}
export class DemoWorkflow extends Worker<DemoWorkflow, WorkflowBinding['Service']>()('DemoWorkflow') {}
export type { DevelopmentWorkflow } from './development-workflow'
