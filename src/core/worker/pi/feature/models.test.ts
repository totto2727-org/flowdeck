import { Array } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makePiModels } from './models.ts'

const gateway = { accountId: 'account', apiKey: 'worker-only-token', gatewayId: 'gateway' }
const sessionId = '0199ef75-0000-7000-8000-000000000001'
const replyStream =
  'data: {"id":"reply","object":"chat.completion.chunk","created":0,"model":"custom-opencode-go/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

describe('development model catalog', () => {
  test('registers only the fixed Gateway model without exposing the credential on the model', () => {
    const { models, model } = makePiModels(gateway)

    expect(models.getModels()).toStrictEqual([model])
    expect(model.id).toBe('custom-opencode-go/deepseek-v4.1-flash')
    expect(model.api).toBe('openai-completions')
    expect(JSON.stringify(model)).not.toContain(gateway.apiKey)
  })
})

describe('development model transport', () => {
  test.each(['complete', 'completeSimple'] as const)(
    '%s uses official Gateway auth and per-conversation OpenCode headers in the real transport',
    async (operation) => {
      const { models, model } = makePiModels(gateway)
      // Substitute only the official transport's fetch boundary. No live inference is performed.
      const response = new Response(replyStream, { headers: { 'content-type': 'text/event-stream' } })
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response)

      const result = await models[operation](
        model,
        { messages: [{ content: 'Hello', role: 'user', timestamp: 0 }] },
        { fetch, sessionId },
      )

      const [input, init] = Array.getUnsafe(fetch.mock.calls, 0)
      const request = new Request(input, init)
      expect({ calls: fetch.mock.calls.length, content: result.content, reason: result.stopReason }).toStrictEqual({
        calls: 1,
        content: [{ text: 'ok', type: 'text' }],
        reason: 'stop',
      })
      expect({
        apiKey: request.headers.has('x-api-key'),
        authorization: request.headers.has('authorization'),
        gateway: request.headers.get('cf-aig-authorization'),
        session: request.headers.get('x-opencode-session'),
        url: request.url,
      }).toStrictEqual({
        apiKey: false,
        authorization: false,
        gateway: `Bearer ${gateway.apiKey}`,
        session: sessionId,
        url: 'https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions',
      })
      await expect(request.json()).resolves.toMatchObject({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'custom-opencode-go/deepseek-v4.1-flash',
        stream: true,
      })
    },
  )
})
