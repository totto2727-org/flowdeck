import type { QueryDatabaseClient } from 'alchemy/Cloudflare/D1'
import { Context } from 'effect'

export class WorkflowDatabase extends Context.Service<WorkflowDatabase, QueryDatabaseClient>()(
  'flowdeck/WorkflowDatabase',
) {}
