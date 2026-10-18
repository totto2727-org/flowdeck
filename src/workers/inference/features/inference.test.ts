import { Effect } from 'effect'
import { HttpRouter } from 'effect/http'
import { describe, expect, it, vi } from 'vite-plus/test'

import { inferenceRoutes, type GatewayCompletion } from './inference'

const model = 'custom-opencode-go/deepseek-v4.1-flash'
const sessionId = '9d11a9ad-691a-40e8-a5c3-754c79ee7e54'
const query = {
  model,
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  max_tokens: 8192,
}
const request = (body: unknown = query, path = '/compat/chat/completions', method = 'POST') =>
  new Request(`http://flowdeck-inference${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer caller-secret',
      'cf-aig-authorization': 'caller-gateway-secret',
      'x-opencode-session': sessionId,
      'x-hostile-header': 'not-forwarded',
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })

// Native Request/Response fixtures exercise the same Effect HTTP boundary as the bound Worker.
describe('private inference gateway boundary', () => {
  it('pins provider, endpoint and model without forwarding caller headers or losing tools', async () => {
    const infer = vi.fn((_input: GatewayCompletion) => Effect.succeed(Response.json({ choices: [] })))
    const handler = HttpRouter.toWebHandler(inferenceRoutes(model, infer))
    try {
      const response = await handler.handler(request())
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ choices: [] })
      expect(infer).toHaveBeenCalledExactlyOnceWith({
        provider: 'compat',
        endpoint: 'chat/completions',
        headers: { 'x-opencode-session': sessionId },
        query,
      })
    } finally {
      await handler.dispose()
    }
  })
  it.each([
    { ...query, model: 'other-model' },
    { ...query, messages: 'not-messages' },
    { ...query, stream: 'yes' },
    { messages: [] },
    null,
  ])('rejects invalid requests before invoking the gateway: %j', async (body) => {
    const infer = vi.fn((_input: GatewayCompletion) => Effect.succeed(Response.json({})))
    const handler = HttpRouter.toWebHandler(inferenceRoutes(model, infer))
    try {
      const response = await handler.handler(request(body))
      expect(response.status).toBe(400)
      expect(infer).not.toHaveBeenCalled()
    } finally {
      await handler.dispose()
    }
  })
  it.each(['not-a-uuid', 'https://attacker.example.com', '9d11a9ad-691a-70e8-a5c3-754c79ee7e54'])(
    'rejects invalid Pi session header %s before gateway work',
    async (session) => {
      const infer = vi.fn((_input: GatewayCompletion) => Effect.succeed(Response.json({})))
      const handler = HttpRouter.toWebHandler(inferenceRoutes(model, infer))
      try {
        const input = request()
        input.headers.set('x-opencode-session', session)
        const response = await handler.handler(input)
        expect(response.status).toBe(400)
        expect(infer).not.toHaveBeenCalled()
      } finally {
        await handler.dispose()
      }
    },
  )
  it('accepts exactly 2 MiB of request bytes, including multibyte text', async () => {
    const input = { ...query, messages: [{ role: 'user', content: 'こんにちは' }] }
    const json = JSON.stringify(input)
    const body = json + ' '.repeat(2 * 1024 * 1024 - new TextEncoder().encode(json).byteLength)
    const infer = vi.fn((_input: GatewayCompletion) => Effect.succeed(Response.json({})))
    const handler = HttpRouter.toWebHandler(inferenceRoutes(model, infer))
    try {
      const response = await handler.handler(
        new Request('http://flowdeck-inference/compat/chat/completions', {
          method: 'POST',
          body,
        }),
      )
      expect(response.status).toBe(200)
      expect(infer).toHaveBeenCalledExactlyOnceWith({
        provider: 'compat',
        endpoint: 'chat/completions',
        headers: {},
        query: input,
      })
    } finally {
      await handler.dispose()
    }
  })
  it('rejects and cancels a chunked body beyond 2 MiB without trusting Content-Length', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024))
        controller.enqueue(new Uint8Array(1))
      },
      cancel,
    })
    const infer = vi.fn((_input: GatewayCompletion) => Effect.succeed(Response.json({})))
    const handler = HttpRouter.toWebHandler(inferenceRoutes(model, infer))
    try {
      // Node's native streaming Request boundary requires duplex, but web RequestInit omits that property.
      const init = { method: 'POST', body, duplex: 'half', headers: { 'content-length': '1' } }
      const response = await handler.handler(new Request('http://flowdeck-inference/compat/chat/completions', init))
      expect(response.status).toBe(413)
      expect(await response.text()).toBe('Inference request too large')
      expect(infer).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      await handler.dispose()
    }
  })
  it.each([
    ['/compat/chat/completions', 'GET'],
    ['/compat/models', 'POST'],
    ['/https://example.com/chat/completions', 'POST'],
    ['/compat/chat/completions?endpoint=https://example.com', 'POST'],
  ])('rejects unsupported endpoint %s and method %s without gateway work', async (path, method) => {
    const infer = vi.fn((_input: GatewayCompletion) => Effect.succeed(Response.json({})))
    const handler = HttpRouter.toWebHandler(inferenceRoutes(model, infer))
    try {
      const response = await handler.handler(request(query, path, method))
      expect(response.status).toBe(404)
      expect(infer).not.toHaveBeenCalled()
    } finally {
      await handler.dispose()
    }
  })
  it('preserves SSE chunks and content type without parsing or buffering the full response', async () => {
    const encoder = new TextEncoder()
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const writer = stream.writable.getWriter()
    const handler = HttpRouter.toWebHandler(
      inferenceRoutes(model, () =>
        Effect.succeed(
          new Response(stream.readable, {
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          }),
        ),
      ),
    )
    try {
      const response = await handler.handler(request())
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      const reader = response.body!.getReader()
      const first = reader.read()
      await writer.write(encoder.encode('data: {"choices":[]}\n\n'))
      expect(await first).toEqual({ done: false, value: encoder.encode('data: {"choices":[]}\n\n') })
      const last = reader.read()
      await writer.write(encoder.encode('data: [DONE]\n\n'))
      expect(await last).toEqual({ done: false, value: encoder.encode('data: [DONE]\n\n') })
      await writer.close()
      expect(await reader.read()).toEqual({ done: true, value: undefined })
    } finally {
      await handler.dispose()
    }
  })
  it.each([301, 401, 403, 429, 500])('sanitizes upstream %s without returning its body or headers', async (status) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('upstream-secret'))
      },
      cancel,
    })
    const handler = HttpRouter.toWebHandler(
      inferenceRoutes(model, () =>
        Effect.succeed(
          new Response(body, {
            status,
            headers: { 'x-provider-diagnostic': 'provider-secret', location: 'https://private.example.com' },
          }),
        ),
      ),
    )
    try {
      const response = await handler.handler(request())
      expect(response.status).toBe(502)
      expect(await response.text()).toBe('Inference unavailable')
      expect(response.headers.get('x-provider-diagnostic')).toBeNull()
      expect(response.headers.get('location')).toBeNull()
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      await handler.dispose()
    }
  })
  it('sanitizes binding transport failures without exposing the cause', async () => {
    const handler = HttpRouter.toWebHandler(
      inferenceRoutes(model, () => Effect.fail(new Error('private gateway diagnostic'))),
    )
    try {
      const response = await handler.handler(request())
      expect(response.status).toBe(502)
      expect(await response.text()).toBe('Inference unavailable')
    } finally {
      await handler.dispose()
    }
  })
})
