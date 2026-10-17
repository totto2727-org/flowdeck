import { Container } from 'alchemy/Cloudflare/Containers'
import { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Config, Effect, Layer, Redacted, Semaphore } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/http'

import { Session, TurnReceipt } from '../../features/jcode/model'
import { BindingError } from '../../features/workflow/domain/errors'
import { JcodeSandbox } from './features/sandbox'

/** Image selection is infrastructure configuration, not a workflow branch. */
export class JcodeContainer extends Container<JcodeContainer>()(
  'JcodeSandbox',
  Effect.gen(function* () {
    const dockerfile = yield* Config.String('FLOWDECK_JCODE_DOCKERFILE').pipe(
      Config.withDefault('containers/jcode/Dockerfile'),
    )
    return { schedulingPolicy: 'durable_object' as const, context: 'containers/jcode', dockerfile }
  }),
) {}

/** Register the native image during construction, then capture request runtime capabilities. */
export const JcodeSandboxLive = Effect.gen(function* () {
  const container = yield* JcodeContainer
  const model = yield* Config.String('FLOWDECK_JCODE_MODEL').pipe(
    Config.withDefault('custom-opencode-go/deepseek-v4.1-flash'),
  )
  // Init-phase Config registers native Worker secret_text bindings, not image/build arguments.
  const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID').pipe(Config.withDefault(''))
  const gatewayId = yield* Config.String('CLOUDFLARE_AI_GATEWAY_ID').pipe(Config.withDefault(''))
  const apiKey = yield* Config.Redacted('CLOUDFLARE_AI_GATEWAY_API_KEY').pipe(Config.withDefault(Redacted.make('')))
  return Layer.effect(
    JcodeSandbox,
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext
      const state = yield* DurableObjectState
      const lock = yield* Semaphore.make(1)
      const start = lock.withPermit(
        Effect.gen(function* () {
          const running = yield* container.running
          if (!running) {
            const attempted = yield* state.storage.get<boolean>('sandbox-start-attempted')
            if (attempted) return yield* new BindingError({ cause: 'Sandbox stopped. Automatic recreation is unsafe.' })
            // Persist before start. A crash at this boundary must not launch a replacement implicitly.
            yield* state.storage.put('sandbox-start-attempted', true)
          }
          yield* container.start({
            enableInternet: true,
            instance: 'standard-1',
            env: {
              JCODE_MODEL: model,
              CLOUDFLARE_ACCOUNT_ID: accountId,
              CLOUDFLARE_AI_GATEWAY_ID: gatewayId,
              CLOUDFLARE_AI_GATEWAY_API_KEY: Redacted.value(apiKey),
            },
          })
          yield* container.setInactivityTimeout(6 * 60 * 60 * 1_000)
        }),
      )
      const request = (input: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          // start is idempotent. Neither a node transition nor a request destroys the workspace.
          yield* start
          const port = yield* container.getTcpPort(8080)
          return yield* port.fetch(input)
        }).pipe(Effect.provideService(RuntimeContext, runtime))
      const successful = (
        response: HttpClientResponse.HttpClientResponse,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, BindingError> =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : Effect.fail(new BindingError({ cause: `Sandbox gateway returned ${response.status}` }))
      const bindError = (cause: unknown) => new BindingError({ cause })
      return JcodeSandbox.of({
        ensureSession: (_runId) =>
          request(HttpClientRequest.post('http://sandbox/session')).pipe(
            Effect.flatMap(successful),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Session)),
            Effect.mapError(bindError),
          ),
        submitTurn: (_runId, input) =>
          HttpClientRequest.bodyJson(HttpClientRequest.post('http://sandbox/turns'), input).pipe(
            Effect.flatMap(request),
            Effect.flatMap(successful),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(TurnReceipt)),
            Effect.mapError(bindError),
          ),
        getTurn: (_runId, commandId) =>
          request(HttpClientRequest.get(`http://sandbox/turns/${commandId}`)).pipe(
            Effect.flatMap((response): Effect.Effect<typeof TurnReceipt.Type | null, unknown> =>
              response.status === 404
                ? Effect.succeed(null)
                : successful(response).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(TurnReceipt))),
            ),
            Effect.mapError(bindError),
          ),
        complete: (_runId) =>
          request(HttpClientRequest.post('http://sandbox/complete')).pipe(
            Effect.flatMap(successful),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Session)),
            Effect.mapError(bindError),
          ),
      })
    }),
  )
}).pipe(Effect.orDie)
