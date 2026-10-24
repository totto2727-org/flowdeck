import { Worker, type WorkerServices } from 'alchemy/Cloudflare/Workers'
import type { HttpEffect } from 'alchemy/Http'
import type { RuntimeContext } from 'alchemy/RuntimeContext'

import type { WorkflowExecutor } from '../features/workflow/services/workflow-definition'
import type { WorkflowService } from '../features/workflow/services/workflows'

/** Lightweight identities and contracts shared by implementations and static bindings. */
export class Frontend extends Worker<Frontend, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Frontend',
) {}
export class Control extends Worker<Control, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Control',
) {}
export class Workflow extends Worker<Workflow, WorkflowService<RuntimeContext>>()('Workflow') {}
export class DemoWorkflow extends Worker<DemoWorkflow, WorkflowExecutor>()('DemoWorkflow') {}
export type { DevelopmentWorkflow } from './development-workflow'
