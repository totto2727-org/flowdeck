import { createPiTools } from '@cloudflare/computer/tools/pi-ai'
import type { CreatePiToolsOptions } from '@cloudflare/computer/tools/pi-ai'
import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import { Array, HashSet, Predicate } from 'effect'

export const CONTAINER_BACKEND = 'container'
export const WORKER_SHELL_BACKEND = 'worker-shell'

const replaySafe = HashSet.make('read', 'ls', 'find', 'grep', 'write', 'delete')

// Pi-durable owns the loop; this boundary pairs Computer's declarations with its dispatcher.
export const createWorkspaceTools = (
  workspace: CreatePiToolsOptions['workspace'],
  backendId = CONTAINER_BACKEND,
): ToolRegistration[] => {
  const { tools, execute } = createPiTools({
    exec: { [backendId]: {} },
    workspace,
  })

  return Array.map(tools, (tool): ToolRegistration => ({
    ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
    description: tool.description,
    async execute(args, api, context): Promise<ToolExecutionResult> {
      const { content, isError } = await execute(
        { arguments: args, id: api.callId, name: tool.name },
        Predicate.isNullish(context.abortSignal) ? {} : { abortSignal: context.abortSignal },
      )
      return { isError, output: content }
    },
    name: tool.name,
    parameters: tool.parameters,
    replay: HashSet.has(replaySafe, tool.name) ? 'safe' : 'unsafe',
  }))
}
