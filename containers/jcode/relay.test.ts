import { Array, Deferred, Effect, Fiber, Redacted, Schema, Stream, String } from 'effect'
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpEffect,
  HttpServerRequest,
} from 'effect/http'
import { TestClock } from 'effect/testing'
import { describe, expect, it, vi } from 'vite-plus/test'

import { GatewayModel } from './sdk'
import { gatewayEndpoint, inferenceRelay } from './server'

const json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(json)
const accountId = String.repeat(32)('a')
const endpoint = `https://gateway.ai.cloudflare.com/v1/${accountId}/flowdeck/compat/chat/completions`
const credential = 'fixture-gateway-secret'
const sessionId = 'stable-session-id'
const payload = { model: GatewayModel, messages: [{ role: 'user', content: 'work' }], stream: true }
// Native Request/Response and readers exist only at Effect's in-process test adapter boundary.
const request = (body: unknown = payload, path = '/v1/chat/completions', method = 'POST') =>
  new Request(`http://127.0.0.1:8081${path}`, {
    method,
    ...(method === 'POST' ? { body: encodeJson(body) } : {}),
    headers: { 'content-type': 'application/json', authorization: 'do-not-forward', 'x-opencode-session': 'untrusted' },
  })

const handler = (client: HttpClient.HttpClient) =>
  inferenceRelay(endpoint, Redacted.make(credential), sessionId).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  )

describe('fixed Cloudflare inference relay', () => {
  it('constructs only the configured HTTPS Gateway path and rejects URL injection', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* gatewayEndpoint(accountId, 'flowdeck')).toBe(endpoint)
        expect(yield* gatewayEndpoint(accountId, '../other').pipe(Effect.result)).toMatchObject({ _tag: 'Failure' })
        expect(yield* gatewayEndpoint('host/override', 'flowdeck').pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
        })
      }),
    )
  })

  it('authenticates the fixed upstream, retains the full model and streams before completion', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void>()
        const bytes = new TextEncoder()
        const first = 'data: {"text":"first"}\n\n'
        const last = 'data: [DONE]\n\n'
        let calls: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((outbound) =>
          Effect.sync(() => {
            calls = Array.append(calls, outbound)
            const stream = Stream.make(bytes.encode(first)).pipe(
              Stream.concat(Stream.fromEffect(Deferred.await(finished).pipe(Effect.as(bytes.encode(last))))),
            )
            return HttpClientResponse.fromWeb(
              outbound,
              new Response(Stream.toReadableStream(stream), {
                headers: { 'content-type': 'text/event-stream', 'set-cookie': 'never-forward-cookie' },
              }),
            )
          }),
        )
        const app = yield* handler(client)
        const handle = HttpEffect.toWebHandler(app)
        const response = yield* Effect.tryPromise(() => handle(request()))
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(response.headers.get('set-cookie')).toBeNull()
        const reader = response.body!.getReader()
        const early = yield* Effect.tryPromise(() => reader.read())
        expect(new TextDecoder().decode(early.value)).toBe(first)
        yield* Deferred.succeed(finished, undefined)
        const tail = yield* Effect.tryPromise(() => reader.read())
        expect(new TextDecoder().decode(tail.value)).toBe(last)
        expect(yield* Effect.tryPromise(() => reader.read())).toMatchObject({ done: true })
        // A reconnect reuses the same transport identity, never the incoming header.
        const second = yield* Effect.tryPromise(() => handle(request()))
        yield* Effect.tryPromise(() => second.text())
        expect(calls).toHaveLength(2)
        const firstCall = Array.getUnsafe(calls, 0)
        const secondCall = Array.getUnsafe(calls, 1)
        expect(firstCall.url).toBe(endpoint)
        expect(firstCall.headers['cf-aig-authorization']).toBe(`Bearer ${credential}`)
        expect(firstCall.headers['authorization']).toBeUndefined()
        expect(firstCall.headers['x-opencode-session']).toBe(sessionId)
        expect(secondCall.headers['x-opencode-session']).toBe(sessionId)
        const body = firstCall.body
        expect(body._tag).toBe('Uint8Array')
        if (body._tag === 'Uint8Array')
          expect(Schema.decodeUnknownSync(json)(new TextDecoder().decode(body.body))).toEqual(payload)
      }),
    )
  })

  it.each([
    ['wrong model', { ...payload, model: 'another/model' }, '/v1/chat/completions', 'POST', 400],
    ['arbitrary path', payload, '/arbitrary', 'POST', 404],
    ['query override', payload, '/v1/chat/completions?url=https://evil.test', 'POST', 404],
    ['wrong method', payload, '/v1/chat/completions', 'GET', 404],
  ] as const)('rejects %s before contacting the upstream', async (_label, body, path, method, status) => {
    const execute = vi.fn((outbound: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(outbound, new Response(''))),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* handler(HttpClient.make(execute))
        const response = yield* Effect.tryPromise(() => HttpEffect.toWebHandler(app)(request(body, path, method)))
        expect(response.status).toBe(status)
        expect(execute).not.toHaveBeenCalled()
      }),
    )
  })

  it.each([401, 402, 429, 500])('preserves upstream rejection %i without retry or diagnostics', async (status) => {
    const execute = vi.fn((outbound: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(outbound, new Response(credential, { status }))),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* handler(HttpClient.make(execute))
        const response = yield* Effect.tryPromise(() => HttpEffect.toWebHandler(app)(request()))
        expect(response.status).toBe(status)
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: 'upstream_rejected' })
        expect(execute).toHaveBeenCalledTimes(1)
      }),
    )
  })

  it('redacts the custom credential and existing sensitive headers in transport inspection', async () => {
    let diagnostic = ''
    const client = HttpClient.make((outbound) =>
      Effect.gen(function* () {
        const error = new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: HttpClientRequest.setHeader(outbound, 'authorization', 'fixture-existing-secret'),
          }),
        })
        diagnostic = yield* Schema.encodeEffect(json)(error).pipe(Effect.orDie)
        return yield* error
      }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* handler(client)
        const response = yield* Effect.tryPromise(() => HttpEffect.toWebHandler(app)(request()))
        expect(response.status).toBe(502)
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: 'upstream_unavailable' })
        expect(diagnostic).not.toContain(credential)
        expect(diagnostic).not.toContain('fixture-existing-secret')
        expect(diagnostic).toContain('redacted')
      }),
    )
  })

  it('bounds an upstream header stall and returns a sanitized timeout', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* handler(HttpClient.make(() => Effect.never))
        const pending = yield* app.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request())),
          Effect.forkChild,
        )
        yield* TestClock.adjust('2 minutes')
        expect((yield* Fiber.join(pending)).status).toBe(504)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  })

  it('fails a stalled SSE body instead of synthesizing successful completion', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = HttpClient.make((outbound) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              outbound,
              new Response(Stream.toReadableStream(Stream.never), { headers: { 'content-type': 'text/event-stream' } }),
            ),
          ),
        )
        const app = yield* handler(client)
        const response = yield* app.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request())),
        )
        expect(response.body._tag).toBe('Stream')
        if (response.body._tag !== 'Stream') return
        const pending = yield* Stream.runDrain(response.body.stream).pipe(Effect.result, Effect.forkChild)
        yield* TestClock.adjust('2 minutes')
        expect(yield* Fiber.join(pending)).toMatchObject({ _tag: 'Failure', failure: 'upstream_timeout' })
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  })

  it('aborts an unconsumed upstream rejection when the request scope closes', async () => {
    let signal: AbortSignal | undefined
    const client = HttpClient.make((outbound, _url, abortSignal) =>
      Effect.sync(() => {
        signal = abortSignal
        return HttpClientResponse.fromWeb(
          outbound,
          new Response(Stream.toReadableStream(Stream.never), { status: 401 }),
        )
      }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* handler(client)
        const response = yield* Effect.tryPromise(() => HttpEffect.toWebHandler(app)(request()))
        expect(response.status).toBe(401)
        yield* Effect.tryPromise(() => response.text())
        expect(signal?.aborted).toBe(true)
      }),
    )
  })
})
