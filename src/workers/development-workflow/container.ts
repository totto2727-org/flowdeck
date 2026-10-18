import { fromCloudflareFetcher } from 'alchemy/Cloudflare'
import { Container } from 'alchemy/Cloudflare/Containers'
import { DurableObjectState, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Config, Effect, Layer, Semaphore } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/http'

import { Session, TurnReceipt } from '../../features/development/model'
import { BindingError } from '../../features/workflow/domain/errors'
import { DevelopmentSandbox } from './features/sandbox'

/** Image selection is infrastructure configuration, not a workflow branch. */
export class DevelopmentContainer extends Container<DevelopmentContainer>()(
  // Compatibility: preserve the deployed resource identity to avoid replacing existing containers.
  'JcodeSandbox',
  Effect.gen(function* () {
    const dockerfile = yield* Config.String('FLOWDECK_PI_DOCKERFILE').pipe(
      Config.withDefault('containers/pi/Dockerfile'),
    )
    return { schedulingPolicy: 'durable_object' as const, context: 'containers/pi', dockerfile }
  }),
) {}

/** Register the native image during construction, then capture request runtime capabilities. */
export const DevelopmentSandboxLive = Effect.gen(function* () {
  const container = yield* DevelopmentContainer
  const environment = yield* WorkerEnvironment
  const model = yield* Config.String('FLOWDECK_PI_MODEL').pipe(
    Config.withDefault('custom-opencode-go/deepseek-v4.1-flash'),
  )
  return Layer.effect(
    DevelopmentSandbox,
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext
      const state = yield* DurableObjectState
      // This is a trusted native service binding, not an HTTP URL or an RPC proxy.
      const inference = fromCloudflareFetcher(environment['INFERENCE'])
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
              PI_MODEL: model,
              PI_INFERENCE_URL: 'http://flowdeck-inference/compat',
            },
          })
          // Native interceptors are not durable across starts. Restore this exact private route every time.
          yield* container.interceptOutboundHttp('flowdeck-inference', inference)
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
      return DevelopmentSandbox.of({
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
