import { WorkerEnvironment, WorkerExecutionContext } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer, Schema } from 'effect'

import { AccessDenied, authorizeAccess, ExpectedAccessAudience } from './access-auth'

const AccessEnvironment = Schema.Struct({ FLOWDECK_ACCESS_AUD: Schema.NonEmptyString })
const decodeAccessEnvironment = Schema.decodeUnknownEffect(AccessEnvironment)

/** Decode native bindings only at the request composition boundary, before domain authorization. */
export const accessAudienceFromEnvironment = (environment: unknown) =>
  decodeAccessEnvironment(environment).pipe(
    Effect.map(({ FLOWDECK_ACCESS_AUD }) => ({ aud: FLOWDECK_ACCESS_AUD })),
    Effect.mapError(() => new AccessDenied({ status: 503, message: 'Access is not configured.' })),
  )

export const AccessAudienceBinding = Layer.effect(
  ExpectedAccessAudience,
  WorkerEnvironment.pipe(Effect.flatMap(accessAudienceFromEnvironment)),
)

/** Both local simulation and production use native admission and identical authorization. */
export const authorizeFrontend = Effect.gen(function* () {
  const expected = yield* ExpectedAccessAudience
  const context = yield* WorkerExecutionContext
  return yield* authorizeAccess(expected, context.access)
}).pipe(Effect.provide(AccessAudienceBinding))
