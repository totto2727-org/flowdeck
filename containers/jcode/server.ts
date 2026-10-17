import { createServer } from 'node:http'

import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ByteSize, Config, Effect, Schema, String } from 'effect'
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { CommandId, TurnRequest } from '../../src/features/jcode/model'
import { Gateway, GatewayError, launchSdk, makeGateway, prepareSdkConfiguration } from './sdk'

const json = HttpServerResponse.jsonUnsafe

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
  yield* prepareSdkConfiguration(model, '/sandbox/.jcode')
  const client = yield* launchSdk
  const gateway = yield* makeGateway(client, model, '/sandbox/.flowdeck')
  const http = yield* application.pipe(Effect.provideService(Gateway, gateway))
  // Native node:http construction is the platform adapter required by NodeHttpServer.
  // This port is private to the Cloudflare Container and never a public host listener.
  const server = yield* NodeHttpServer.make(createServer, { host: '0.0.0.0', port: 8080 })
  yield* server.serve(http)
  yield* Effect.never
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
