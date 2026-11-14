import { Worker } from 'alchemy/Cloudflare/Workers'

import type { WireWorkflowExecutor } from '@/core/feature/workflow/rpc/contract'

/** Lightweight identity shared by infrastructure and statically bound callers. */
export class DemoWorkflow extends Worker<DemoWorkflow, WireWorkflowExecutor>()('DemoWorkflow') {}
