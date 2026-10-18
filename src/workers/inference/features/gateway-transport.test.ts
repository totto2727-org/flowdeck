import { Effect, Redacted } from 'effect'
import { FetchHttpClient, Headers, HttpClient, HttpClientResponse, HttpRouter } from 'effect/http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { makeGatewayTransport } from './gateway-transport'
import { inferenceRoutes, type GatewayCompletion } from './inference'

const key = 'worker-only-test-secret'
const config = { accountId: 'account-1', gatewayId: 'existing-gateway', apiKey: Redacted.make(key) }
const model = 'custom-opencode-go/deepseek-v4.1-flash'
const sessionId = '9d11a9ad-691a-40e8-a5c3-754c79ee7e54'
const query = { model, messages: [{ role: 'user', content: 'Hello' }], stream: true }
const input: GatewayCompletion = {
  provider: 'compat',
  endpoint: 'chat/completions',
  headers: { 'x-opencode-session': sessionId },
  query,
}
const request = () =>
  new Request('http://flowdeck-inference/compat/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer caller-secret',
      'cf-aig-authorization': 'caller-key',
      'x-opencode-session': sessionId,
      'x-hostile-header': 'ignored',
    },
    body: JSON.stringify(query),
  })

// A local Fetch override is the native transport fixture. The global fallback always fails to prohibit real network I/O.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Real network prohibited'))),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})
const handlerWith = (fetch: typeof globalThis.fetch) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const transport = yield* makeGatewayTransport(config)
      return HttpRouter.toWebHandler(inferenceRoutes(model, transport))
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch)),
  )

describe('Worker-only gateway HTTP transport', () => {
  it('uses fixed HTTPS compat URL and Worker-only key with UUID correlation and unchanged model', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const outbound = new Request(url, init)
      expect(outbound.url).toBe(
        'https://gateway.ai.cloudflare.com/v1/account-1/existing-gateway/compat/chat/completions',
      )
      expect(outbound.method).toBe('POST')
      expect(outbound.headers.get('cf-aig-authorization')).toBe(`Bearer ${key}`)
      expect(outbound.headers.get('x-opencode-session')).toBe(sessionId)
      expect(outbound.headers.get('authorization')).toBeNull()
      expect(outbound.headers.get('x-hostile-header')).toBeNull()
      expect(outbound.headers.get('traceparent')).toBeNull()
      expect(outbound.redirect).toBe('manual')
      expect(outbound.credentials).toBe('omit')
      expect(await outbound.json()).toEqual(query)
      return Response.json({ choices: [] })
    })
    const handler = await handlerWith(fetch)
    try {
      const response = await handler.handler(request())
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ choices: [] })
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      await handler.dispose()
    }
  })
  it('keeps an upstream SSE response alive after returning headers and cancels on downstream cancellation', async () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const writer = stream.writable.getWriter()
    let signal: AbortSignal | null | undefined
    const fetch: typeof globalThis.fetch = vi.fn(async (_url, init) => {
      signal = init?.signal
      return new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } })
    })
    const handler = await handlerWith(fetch)
    try {
      const response = await handler.handler(request())
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      expect(signal?.aborted).toBe(false)
      const reader = response.body!.getReader()
      const first = reader.read()
      const bytes = new TextEncoder().encode('data: {"choices":[]}\n\n')
      await writer.write(bytes)
      expect(await first).toEqual({ done: false, value: bytes })
      expect(signal?.aborted).toBe(false)
      await reader.cancel()
      await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    } finally {
      await handler.dispose()
    }
  })
  it.each([302, 401, 500])('does not redirect, exposes no diagnostics and releases upstream %s', async (status) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('upstream-private-secret'))
      },
      cancel,
    })
    const fetch: typeof globalThis.fetch = vi.fn(
      async () =>
        new Response(body, {
          status,
          headers: { location: 'https://attacker.example.com', 'x-private-diagnostic': 'private' },
        }),
    )
    const handler = await handlerWith(fetch)
    try {
      const response = await handler.handler(request())
      expect(response.status).toBe(502)
      expect(await response.text()).toBe('Inference unavailable')
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('x-private-diagnostic')).toBeNull()
      expect(fetch).toHaveBeenCalledOnce()
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      await handler.dispose()
    }
  })
  it('sanitizes transport errors that contain the Worker key', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async () => {
      throw new Error(`Failure with ${key}`)
    })
    const handler = await handlerWith(fetch)
    try {
      const response = await handler.handler(request())
      expect(response.status).toBe(502)
      expect(await response.text()).toBe('Inference unavailable')
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      await handler.dispose()
    }
  })
  it('adds gateway key redaction without removing default sensitive header redaction', async () => {
    const client = HttpClient.make((outbound) =>
      Effect.gen(function* () {
        const names = yield* Headers.CurrentRedactedNames
        expect(names).toContain('cf-aig-authorization')
        expect(names).toContain('authorization')
        expect(names).toContain('cookie')
        const inspected = JSON.stringify(Headers.redact(outbound.headers, names))
        expect(inspected).not.toContain(key)
        expect(inspected).toContain('<redacted>')
        return HttpClientResponse.fromWeb(outbound, Response.json({ choices: [] }))
      }),
    )
    const transport = await Effect.runPromise(
      makeGatewayTransport(config).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )
    const response = await Effect.runPromise(transport(input))
    expect(await response.json()).toEqual({ choices: [] })
  })
})
