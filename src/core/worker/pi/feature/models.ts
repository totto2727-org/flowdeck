import { createModels, createProvider } from '@earendil-works/pi-ai'
import type { Model, Models } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { cloudflareAIGatewayAuth } from '@earendil-works/pi-ai/providers/cloudflare-auth'
import { withOpenCodeSessionHeader } from '@earendil-works/pi-ai/providers/opencode-headers'

// Native pi-ai configuration boundary. Credentials stay in the Worker-owned Models collection.
export const makePiModels = (config: {
  accountId: string
  apiKey: string
  gatewayId: string
}): { models: Models; model: Model<'openai-completions'> } => {
  const env: Record<string, string | undefined> = {
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
    CLOUDFLARE_API_KEY: config.apiKey,
    CLOUDFLARE_GATEWAY_ID: config.gatewayId,
  }
  const models = createModels({
    authContext: {
      // oxlint-disable-next-line typescript/require-await -- Pi's AuthContext requires a Promise even for in-memory Worker bindings.
      env: async (name) => env[name],
      // oxlint-disable-next-line typescript/require-await -- Pi's AuthContext requires a Promise and this Worker has no authentication files.
      fileExists: async () => false,
    },
  })
  const model: Model<'openai-completions'> = {
    api: 'openai-completions',
    baseUrl: `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/compat`,
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: 'custom-opencode-go/deepseek-v4.1-flash',
    input: ['text'],
    maxTokens: 8192,
    name: 'DeepSeek V4.1 Flash',
    provider: 'cloudflare-ai-gateway',
    reasoning: false,
  }
  const api = withOpenCodeSessionHeader(openAICompletionsApi())
  const gatewayProvider = createProvider({
    api,
    auth: { apiKey: cloudflareAIGatewayAuth() },
    id: model.provider,
    models: [model],
  })
  models.setProvider(gatewayProvider)
  return { model, models }
}
