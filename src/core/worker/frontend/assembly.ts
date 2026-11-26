import { WorkerEnvironment, WorkerExecutionContext } from 'alchemy/Cloudflare/Workers'
import { Context, Effect, Layer, Predicate, Result, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { frontendAuthorization } from '@/core/worker/frontend/feature/authorization'
import { ControlApi, makeControlApi } from '@/core/worker/frontend/feature/control-api'
import { makeWebWorker, WebWorker } from '@/core/worker/frontend/feature/worker'
import { HttpStatus } from '@/share/feature/http/status'

import { AccessDenied, authorizeAccess } from './access-auth.ts'

const AccessEnvironment = Schema.Struct({ FLOWDECK_ACCESS_AUD: Schema.NonEmptyString })
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Native Workers bindings may be absent or supplied with the wrong runtime type.
const decodeAccessEnvironment = Schema.decodeUnknownEffect(AccessEnvironment)

/**
 * Decodes the native Access audience before request authorization.
 * @param {unknown} environment The native Worker bindings.
 * @returns {Effect.Effect<{ aud: string }, AccessDenied>} The configured audience or a checked Access failure.
 */
export const accessAudienceFromEnvironment = (environment: unknown): Effect.Effect<{ aud: string }, AccessDenied> =>
  decodeAccessEnvironment(environment).pipe(
    Effect.map(({ FLOWDECK_ACCESS_AUD }) => ({ aud: FLOWDECK_ACCESS_AUD })),
    Effect.mapError(
      () => new AccessDenied({ message: 'Access is not configured.', status: HttpStatus.serviceUnavailable }),
    ),
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

type ControlBindingFields = Readonly<{ fetch: (request: Request) => Promise<Response> }>

// oxlint-disable-next-line typescript/no-empty-object-type, typescript/no-empty-interface -- Preserve the native Fetcher interface and its structural extensions.
export interface ControlBinding extends ControlBindingFields {}
const ControlEnvironment = Schema.Struct({
  CONTROL: Schema.declare(
    // oxlint-disable-next-line rules/no-type-predicate -- The native Fetcher keeps its prototype and receiver. Validate the method without copying the binding into a struct.
    (input): input is ControlBinding =>
      Predicate.isObject(input) && Predicate.hasProperty(input, 'fetch') && Predicate.isFunction(input.fetch),
  ),
})
const decodeControlEnvironment = Schema.decodeUnknownResult(ControlEnvironment)

/**
 * The service binding exposes native fetch, not an Effect HTTP interface.
 * Effect's official FetchHttpClient owns request execution and error translation.
 * This request-local adapter only decodes the binding and converts its native Request.
 * Decode on dispatch so Control configuration cannot bypass Access middleware ordering.
 */
export const makeControlFetch = Effect.gen(function* () {
  const environment = yield* WorkerEnvironment
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const environmentResult = decodeControlEnvironment(environment)
    const { CONTROL } = Result.getOrThrow(environmentResult)
    return CONTROL.fetch(new Request(input, init))
  }
  return fetch
})

const nativeControlFetch = Layer.effect(FetchHttpClient.Fetch, makeControlFetch)
const controlHttpClient = FetchHttpClient.layer.pipe(Layer.provide(nativeControlFetch))
const controlApi = Layer.effect(ControlApi, makeControlApi).pipe(Layer.provide(controlHttpClient))
const admission = Layer.effect(FrontendAdmission, makeFrontendAdmission)
const requestDependencies = Layer.mergeAll(admission, controlApi)

/** Builds the frontend graph per request using that request's native bindings. */
export const FrontendRequestLayer = Layer.effect(WebWorker, makeWebWorker).pipe(Layer.provideMerge(requestDependencies))

const checkAdmission = FrontendAdmission.pipe(Effect.flatMap((service) => service.check))
export const frontendRequest = WebWorker.pipe(
  Effect.flatMap((worker) => worker.fetch),
  frontendAuthorization(checkAdmission),
)
