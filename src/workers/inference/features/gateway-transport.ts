import { Array, Data, Effect, Redacted, Stream } from 'effect'
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from 'effect/http'

import type { GatewayCompletion } from './inference'

class InferenceTransportError extends Data.TaggedError('InferenceTransportError') {}

/** Credentials stay in the private Worker. No caller URL or authentication header enters this transport. */
export const makeGatewayTransport = (config: {
  readonly accountId: string
  readonly gatewayId: string
  readonly apiKey: Redacted.Redacted<string>
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const redactedNames = yield* Headers.CurrentRedactedNames
    const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}/compat/chat/completions`
    return (input: GatewayCompletion) =>
      Effect.gen(function* () {
        const sessionId = input.headers['x-opencode-session']
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeaders({
              'cf-aig-authorization': `Bearer ${Redacted.value(config.apiKey)}`,
              ...(sessionId === undefined ? {} : { 'x-opencode-session': sessionId }),
            }),
          ),
          input.query,
        )
        const response = yield* client.execute(request)
        // The client owns cancellation until the response stream finishes or its downstream consumer cancels.
        // Do not use Effect.scoped/HttpClient.withScope here: returning headers must not abort an in-flight SSE body.
        const body = yield* Stream.toReadableStreamEffect(
          response.stream.pipe(Stream.mapError(() => new InferenceTransportError())),
        )
        return new Response(body, { status: response.status, headers: response.headers })
      }).pipe(
        Effect.mapError(() => new InferenceTransportError()),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual', credentials: 'omit' }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provideService(Headers.CurrentRedactedNames, Array.append(redactedNames, 'cf-aig-authorization')),
      )
  })
