import { createServer } from 'node:http'

import { NodeHttpClient, NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Array, ByteSize, Config, Effect, Redacted, Schema, Stream, String } from 'effect'
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http'

import { CommandId, TurnRequest } from '../../src/features/jcode/model'
import {
  Gateway,
  GatewayError,
  GatewayModel,
  launchSdk,
  makeGateway,
  prepareRelaySession,
  prepareSdkConfiguration,
} from './sdk'

const json = HttpServerResponse.jsonUnsafe

export const gatewayEndpoint = (accountId: string, gatewayId: string) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{32}$/)))(accountId)
    yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)))(
      gatewayId,
    )
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`
  })

/** Jcode 0.98.1 cannot send custom Bearer and session headers to this host.
 * Named Bearer auth fixes Authorization, raw Header auth does not add Bearer,
 * and the OpenCode session header is restricted to opencode.ai hosts.
 * https://github.com/1jehuang/jcode/blob/1c7426eb1/crates/jcode-provider-openrouter-runtime/src/lib.rs#L1321-L1369
 * https://github.com/1jehuang/jcode/blob/1c7426eb1/crates/jcode-provider-openrouter-runtime/src/request_headers.rs#L47-L78
 * This fixed loopback-only adapter is not exposed through the public gateway.
 * No incoming URL or headers can choose an upstream or override credentials.
 */
export const inferenceRelay = (endpoint: string, apiKey: Redacted.Redacted<string>, sessionId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const redactedNames = yield* Headers.CurrentRedactedNames
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        return json({ error: 'not_found' }, { status: 404 })
      }
      const body = yield* request.json
      yield* Schema.decodeUnknownEffect(Schema.Struct({ model: Schema.Literal(GatewayModel) }))(body)
      // The only secret unwrap is the outbound header, never config, argv or logs.
      const outbound = yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.setHeaders({
          'cf-aig-authorization': `Bearer ${Redacted.value(apiKey)}`,
          'x-opencode-session': sessionId,
          accept: 'text/event-stream, application/json',
        }),
        HttpClientRequest.bodyJson(body),
      )
      // No retries or redirects: SDK outcome uncertainty must not duplicate work.
      const response = yield* HttpClient.withScope(client).execute(outbound).pipe(Effect.timeout('2 minutes'))
      if (response.status < 200 || response.status >= 300) {
        // Preserve rejection status, not potentially sensitive upstream diagnostics.
        return json({ error: 'upstream_rejected' }, { status: response.status })
      }
      return HttpServerResponse.stream(
        response.stream.pipe(
          Stream.mapError(() => 'upstream_stream_failed'),
          Stream.timeoutOrElse({ duration: '2 minutes', orElse: () => Stream.fail('upstream_timeout') }),
        ),
        { status: response.status, contentType: response.headers['content-type'] ?? 'application/octet-stream' },
      )
    }).pipe(
      Effect.provideService(Headers.CurrentRedactedNames, Array.append(redactedNames, 'cf-aig-authorization')),
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(4)),
      Effect.catchTags({
        SchemaError: () => Effect.succeed(json({ error: 'unsupported_model' }, { status: 400 })),
        TimeoutError: () => Effect.succeed(json({ error: 'upstream_timeout' }, { status: 504 })),
        HttpServerError: () => Effect.succeed(json({ error: 'invalid_request' }, { status: 400 })),
      }),
      Effect.catch(() => Effect.succeed(json({ error: 'upstream_unavailable' }, { status: 502 }))),
    )
  })

export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const gateway = yield* Gateway
    yield* router.add('GET', '/health', json({ status: 'ok' }))
    yield* router.add('POST', '/session', gateway.ensure.pipe(Effect.map((session) => json(session))))
    yield* router.add(
      'POST',
      '/turns',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.schemaBodyJson(TurnRequest)
        const receipt = yield* gateway.submit(request)
        return json(receipt, { status: receipt.status === 'running' ? 202 : 200 })
      }),
    )
    yield* router.add(
      'GET',
      '/turns/:commandId',
      Effect.gen(function* () {
        const { commandId } = yield* HttpRouter.schemaPathParams(Schema.Struct({ commandId: CommandId }))
        return json(yield* gateway.getTurn(commandId))
      }),
    )
    yield* router.add('POST', '/complete', gateway.complete.pipe(Effect.map((session) => json(session))))
  }),
)

export const application = Effect.gen(function* () {
  const http = yield* HttpRouter.toHttpEffect(routes)
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    // Node's cached body reader enforces the byte limit even for chunked bodies.
    // Read before routing so bodyless endpoints cannot bypass the same bound.
    const body = yield* request.text.pipe(
      Effect.mapError((cause) => new GatewayError({ status: 413, code: 'body_unreadable_or_too_large', cause })),
    )
    if (new TextEncoder().encode(body).byteLength > 65_536) {
      return yield* new GatewayError({ status: 413, code: 'body_too_large' })
    }
    return yield* http
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
    Effect.catchTags({
      GatewayError: (error) => Effect.succeed(json({ error: error.code }, { status: error.status })),
      SchemaError: () => Effect.succeed(json({ error: 'invalid_request' }, { status: 400 })),
      HttpServerError: (error) =>
        Effect.succeed(
          json(
            { error: 'invalid_request' },
            {
              status:
                error.reason._tag === 'RouteNotFound' ? 404 : error.reason._tag === 'RequestParseError' ? 400 : 500,
            },
          ),
        ),
    }),
    // Filesystem and SDK diagnostics may contain secrets. Never serialize causes.
    Effect.catch(() => Effect.succeed(json({ error: 'request_failed' }, { status: 500 }))),
  )
})

const main = Effect.gen(function* () {
  const model = yield* Config.String('JCODE_MODEL')
  if (String.length(model) === 0) return yield* Effect.fail('JCODE_MODEL must not be empty')
  yield* prepareSdkConfiguration(model, '/home/sandbox/.jcode')
  const endpoint = yield* gatewayEndpoint(
    yield* Config.String('CLOUDFLARE_ACCOUNT_ID'),
    yield* Config.String('CLOUDFLARE_AI_GATEWAY_ID'),
  )
  const apiKey = yield* Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY')
  if (String.length(Redacted.value(apiKey)) === 0) return yield* Effect.fail('Gateway authentication is required')
  const sessionId = yield* prepareRelaySession('/home/sandbox/.flowdeck')
  const relay = yield* inferenceRelay(endpoint, apiKey, sessionId)
  const relayServer = yield* NodeHttpServer.make(createServer, { host: '127.0.0.1', port: 8081 })
  yield* relayServer.serve(relay)
  const client = yield* launchSdk
  const gateway = yield* makeGateway(client, model, '/home/sandbox/.flowdeck')
  const http = yield* application.pipe(Effect.provideService(Gateway, gateway))
  // Native node:http construction is the platform adapter required by NodeHttpServer.
  // This port is private to the Cloudflare Container and never a public host listener.
  const server = yield* NodeHttpServer.make(createServer, { host: '0.0.0.0', port: 8080 })
  yield* server.serve(http)
  yield* Effect.never
}).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.scoped, Effect.provide(NodeServices.layer))

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
