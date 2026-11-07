import { describe, expect, it, vi } from 'vite-plus/test'

import { makeDevelopmentModels } from './models'

describe('development models', () => {
  it('registers only the fixed Gateway model without exposing the credential on the model', () => {
    const { models, model } = makeDevelopmentModels({
      accountId: 'account',
      gatewayId: 'gateway',
      apiKey: 'worker-only-token',
    })

    expect(models.getModels()).toEqual([model])
    expect(model.id).toBe('custom-opencode-go/deepseek-v4.1-flash')
    expect(model.api).toBe('openai-completions')
    expect(JSON.stringify(model)).not.toContain('worker-only-token')
  })

  it.each(['complete', 'completeSimple'] as const)(
    '%s uses official Gateway auth and per-conversation OpenCode headers in the real transport',
    async (operation) => {
      const { models, model } = makeDevelopmentModels({
        accountId: 'account',
        gatewayId: 'gateway',
        apiKey: 'worker-only-token',
      })
      // Substitute only the official transport's fetch boundary. No live inference is performed.
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            'data: {"id":"reply","object":"chat.completion.chunk","created":0,"model":"custom-opencode-go/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      )

      const result = await models[operation](
        model,
        { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] },
        { fetch, sessionId: '0199ef75-0000-7000-8000-000000000001' },
      )

      expect(result.stopReason).toBe('stop')
      expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
      expect(fetch).toHaveBeenCalledOnce()
      const call = fetch.mock.calls[0]!
      const request = new Request(call[0], call[1])
      expect(request.url).toBe('https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions')
      expect(request.headers.get('cf-aig-authorization')).toBe('Bearer worker-only-token')
      expect(request.headers.has('authorization')).toBe(false)
      expect(request.headers.has('x-api-key')).toBe(false)
      expect(request.headers.get('x-opencode-session')).toBe('0199ef75-0000-7000-8000-000000000001')
      expect(await request.json()).toMatchObject({
        model: 'custom-opencode-go/deepseek-v4.1-flash',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      })
    },
  )
})
