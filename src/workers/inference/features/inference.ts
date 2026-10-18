import { Data, Effect, Schema, Stream } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

const CompletionRequest = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.String,
    messages: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
    stream: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)
export type CompletionRequest = typeof CompletionRequest.Type
class InferenceBodyTooLarge extends Data.TaggedError('InferenceBodyTooLarge') {}
const maxBodyBytes = 2 * 1024 * 1024
const SessionHeaders = Schema.Struct({
  'x-opencode-session': Schema.optional(Schema.String.check(Schema.isUUID(4))),
})
export interface GatewayCompletion {
  readonly provider: 'compat'
  readonly endpoint: 'chat/completions'
  readonly headers: typeof SessionHeaders.Type
  readonly query: CompletionRequest
}

/** The native AI Gateway response is the narrow streaming interoperability boundary. */
export const inferenceRoutes = <E, R>(
  model: string,
  infer: (input: GatewayCompletion) => Effect.Effect<Response, E, R>,
) =>
  HttpRouter.use((router) =>
    router.add(
      'POST',
      '/compat/chat/completions',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.url !== '/compat/chat/completions') return HttpServerResponse.empty({ status: 404 })
        // Pi's persisted conversation UUID is routing metadata, never an authorization credential.
        const headers = yield* Schema.decodeUnknownEffect(SessionHeaders)(request.headers)
        let bodyBytes = 0
        // The Web Request adapter does not enforce MaxBodySize when reading .json or .text.
        const query = yield* request.stream.pipe(
          Stream.mapEffect((chunk) => {
            bodyBytes += chunk.byteLength
            return bodyBytes <= maxBodyBytes ? Effect.succeed(chunk) : Effect.fail(new InferenceBodyTooLarge())
          }),
          Stream.decodeText(),
          Stream.mkString,
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CompletionRequest))),
        )
        if (query.model !== model) return HttpServerResponse.text('Unsupported model', { status: 400 })
        return yield* infer({ provider: 'compat', endpoint: 'chat/completions', headers, query }).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed(HttpServerResponse.fromWeb(response))
              : Effect.tryPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
                  Effect.ignore,
                  Effect.as(HttpServerResponse.text('Inference unavailable', { status: 502 })),
                ),
          ),
          Effect.catch(() => Effect.succeed(HttpServerResponse.text('Inference unavailable', { status: 502 }))),
        )
      }).pipe(
        Effect.catchTags({
          InferenceBodyTooLarge: () =>
            Effect.succeed(HttpServerResponse.text('Inference request too large', { status: 413 })),
          SchemaError: () => Effect.succeed(HttpServerResponse.text('Invalid inference request', { status: 400 })),
          HttpServerError: () => Effect.succeed(HttpServerResponse.text('Invalid inference request', { status: 400 })),
        }),
      ),
    ),
  )
