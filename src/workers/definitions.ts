import { Worker, type WorkerServices } from 'alchemy/Cloudflare/Workers'
import type { HttpEffect } from 'alchemy/Http'
import type { RuntimeContext } from 'alchemy/RuntimeContext'

import type { WireWorkflowExecutor, WireWorkflowService } from '../features/workflow/services/workflow-rpc'

/** Lightweight identities and contracts shared by implementations and static bindings. */
export class Frontend extends Worker<Frontend, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Frontend',
) {}
export class Control extends Worker<Control, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Control',
) {}
export class Workflow extends Worker<Workflow, WireWorkflowService<RuntimeContext>>()('Workflow') {}
export class DemoWorkflow extends Worker<DemoWorkflow, WireWorkflowExecutor>()('DemoWorkflow') {}
export type { DevelopmentWorkflow } from './development-workflow/development-workflow'
