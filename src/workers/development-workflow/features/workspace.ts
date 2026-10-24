import { createPiTools, type CreatePiToolsOptions } from '@cloudflare/computer/tools/pi-ai'
import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import { Array, HashSet } from 'effect'

export const CONTAINER_BACKEND = 'container'

const replaySafe = HashSet.make('read', 'ls', 'find', 'grep', 'write', 'delete')

// Pi-durable owns the loop; this boundary pairs Computer's declarations with its dispatcher.
export const createWorkspaceTools = (workspace: CreatePiToolsOptions['workspace']): ToolRegistration[] => {
  const { tools, execute } = createPiTools({
    workspace,
    shell: {
      defaultBackend: CONTAINER_BACKEND,
      backends: { [CONTAINER_BACKEND]: {} },
    },
  })

  return Array.map(tools, (tool): ToolRegistration => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
    replay: HashSet.has(replaySafe, tool.name) ? 'safe' : 'unsafe',
    async execute(args, api, context): Promise<ToolExecutionResult> {
      const { content, isError } = await execute(
        { id: api.callId, name: tool.name, arguments: args },
        context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal },
      )
      return { output: content, isError }
    },
  }))
}
