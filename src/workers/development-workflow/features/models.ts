import { createModels, createProvider, type Model, type Models } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { cloudflareAIGatewayAuth } from '@earendil-works/pi-ai/providers/cloudflare-auth'
import { withOpenCodeSessionHeader } from '@earendil-works/pi-ai/providers/opencode-headers'

// Native pi-ai configuration boundary. Credentials stay in the Worker-owned Models collection.
export const makeDevelopmentModels = (config: {
  accountId: string
  gatewayId: string
  apiKey: string
}): { models: Models; model: Model<'openai-completions'> } => {
  const env: Record<string, string | undefined> = {
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
    CLOUDFLARE_GATEWAY_ID: config.gatewayId,
    CLOUDFLARE_API_KEY: config.apiKey,
  }
  const models = createModels({
    authContext: {
      env: async (name) => env[name],
      fileExists: async () => false,
    },
  })
  const model: Model<'openai-completions'> = {
    id: 'custom-opencode-go/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    api: 'openai-completions',
    provider: 'cloudflare-ai-gateway',
    baseUrl: `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/compat`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8192,
  }
  models.setProvider(
    createProvider({
      id: model.provider,
      auth: { apiKey: cloudflareAIGatewayAuth() },
      models: [model],
      api: withOpenCodeSessionHeader(openAICompletionsApi()),
    }),
  )
  return { models, model }
}
