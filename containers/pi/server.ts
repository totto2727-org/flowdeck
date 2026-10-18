import { createServer } from 'node:http'

import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ByteSize, Config, Effect, Schema, String } from 'effect'
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { CommandId, TurnRequest } from '../../src/features/development/model'
import { Gateway, GatewayError, launchSdk, makeGateway } from './sdk'

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
    // Node's body reader bounds chunked requests before bodyless routes can accept them.
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
    // Provider, filesystem and tool diagnostics must not leak through the HTTP boundary.
    Effect.catch(() => Effect.succeed(json({ error: 'request_failed' }, { status: 500 }))),
  )
})

const main = Effect.gen(function* () {
  const model = yield* Config.String('PI_MODEL')
  if (String.length(model) === 0) return yield* Effect.fail('PI_MODEL must not be empty')
  const baseUrl = yield* Config.String('PI_INFERENCE_URL')
  const directory = '/home/sandbox/.flowdeck'
  const factory = yield* launchSdk({ baseUrl })
  const gateway = yield* makeGateway(factory, model, directory)
  const http = yield* application.pipe(Effect.provideService(Gateway, gateway))
  // node:http is the platform adapter. The Container port is private to its Worker.
  const server = yield* NodeHttpServer.make(createServer, { host: '0.0.0.0', port: 8080 })
  yield* server.serve(http)
  yield* Effect.never
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
