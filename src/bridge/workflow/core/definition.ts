import { Worker } from 'alchemy/Cloudflare/Workers'

import type { WireWorkflowService } from '@/core/feature/workflow/rpc/contract'

export class Workflow extends Worker<Workflow, WireWorkflowService>()('Workflow') {}
