import { Worker } from 'alchemy/Cloudflare/Workers'

import type { WireWorkflowExecutor } from '@/features/workflow/services/workflow-rpc'

/** Lightweight identity shared by infrastructure and statically bound callers. */
export class DevelopmentWorkflow extends Worker<DevelopmentWorkflow, WireWorkflowExecutor>()('DevelopmentWorkflow') {}

export default DevelopmentWorkflow
