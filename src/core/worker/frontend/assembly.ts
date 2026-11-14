import { WorkerEnvironment, WorkerExecutionContext } from 'alchemy/Cloudflare/Workers'
import { Context, Effect, Layer, Predicate, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { frontendAuthorization } from '@/core/worker/frontend/feature/authorization'
import { ControlApi, makeControlApi } from '@/core/worker/frontend/feature/control-api'
import { makeWebWorker, WebWorker } from '@/core/worker/frontend/feature/worker'

import { AccessDenied, authorizeAccess } from './access-auth'

const AccessEnvironment = Schema.Struct({ FLOWDECK_ACCESS_AUD: Schema.NonEmptyString })
const decodeAccessEnvironment = Schema.decodeUnknownEffect(AccessEnvironment)

/** Decode native bindings only at the request composition boundary, before domain authorization. */
export const accessAudienceFromEnvironment = (environment: unknown) =>
  decodeAccessEnvironment(environment).pipe(
    Effect.map(({ FLOWDECK_ACCESS_AUD }) => ({ aud: FLOWDECK_ACCESS_AUD })),
    Effect.mapError(() => new AccessDenied({ status: 503, message: 'Access is not configured.' })),
  )

/** Construct inside each request. Missing configuration remains a checked middleware failure. */
export const makeFrontendAdmission = Effect.gen(function* () {
  const environment = yield* WorkerEnvironment
  const context = yield* WorkerExecutionContext
  return {
    check: accessAudienceFromEnvironment(environment).pipe(
      Effect.flatMap((expected) => authorizeAccess(expected, context.access)),
    ),
  }
})

export class FrontendAdmission extends Context.Service<
  FrontendAdmission,
  Effect.Success<typeof makeFrontendAdmission>
>()('flowdeck/FrontendAdmission') {}

export interface ControlBinding {
  readonly fetch: (request: Request) => Promise<Response>
}
const ControlEnvironment = Schema.Struct({
  CONTROL: Schema.declare(
    (input): input is ControlBinding =>
      Predicate.isObject(input) && Predicate.hasProperty(input, 'fetch') && Predicate.isFunction(input.fetch),
  ),
})
const decodeControlEnvironment = Schema.decodeUnknownSync(ControlEnvironment)

/**
 * The service binding exposes native fetch, not an Effect HTTP interface.
 * Effect's official FetchHttpClient owns request execution and error translation.
 * This request-local adapter only decodes the binding and converts its native Request.
 * Decode on dispatch so Control configuration cannot bypass Access middleware ordering.
 */
export const makeControlFetch = Effect.gen(function* () {
  const environment = yield* WorkerEnvironment
  const fetch: typeof globalThis.fetch = (input, init) =>
    decodeControlEnvironment(environment).CONTROL.fetch(new Request(input, init))
  return fetch
})

/** The complete frontend graph is rebuilt per request, never across request-affine bindings. */
export const FrontendRequestLayer = Layer.effect(WebWorker, makeWebWorker).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effect(FrontendAdmission, makeFrontendAdmission),
      Layer.effect(ControlApi, makeControlApi).pipe(
        Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.effect(FetchHttpClient.Fetch, makeControlFetch)))),
      ),
    ),
  ),
)

export const frontendRequest = WebWorker.pipe(
  Effect.flatMap((worker) => worker.fetch),
  frontendAuthorization(FrontendAdmission.pipe(Effect.flatMap((admission) => admission.check))),
)
