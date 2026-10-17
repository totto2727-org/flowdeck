import { WorkerEnvironment, WorkerExecutionContext } from 'alchemy/Cloudflare/Workers'
import { Array, Data, Effect, Schema } from 'effect'

const AccessEnvironment = Schema.Union([
  Schema.Struct({ FLOWDECK_LOCAL_DEV: Schema.Literal(true) }),
  Schema.Struct({
    FLOWDECK_LOCAL_DEV: Schema.Literal(false),
    FLOWDECK_ACCESS_AUD: Schema.String.check(Schema.isMinLength(1)),
    FLOWDECK_ACCESS_EMAILS: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  }),
])

export class AccessDenied extends Data.TaggedError('AccessDenied')<{
  readonly status: 401 | 403 | 503
  readonly message: string
}> {}

interface AccessAdmission<R> {
  readonly aud: string
  readonly getIdentity: () => Effect.Effect<{ readonly email?: string } | undefined, unknown, R>
}

/** Verify native platform admission and the configured application identity boundary. */
export const authorizeAccess = <R>(
  environment: unknown,
  admission: Effect.Effect<AccessAdmission<R> | undefined, never, R>,
) =>
  Effect.gen(function* () {
    const settings = yield* Schema.decodeUnknownEffect(AccessEnvironment)(environment).pipe(
      Effect.mapError(() => new AccessDenied({ status: 503, message: 'Access is not configured.' })),
    )
    // Only `alchemy dev` injects this binding. There is no request-controlled bypass.
    if (settings.FLOWDECK_LOCAL_DEV) return
    const access = yield* admission
    if (access === undefined) {
      return yield* new AccessDenied({ status: 401, message: 'Cloudflare Access authentication is required.' })
    }
    if (access.aud !== settings.FLOWDECK_ACCESS_AUD) {
      return yield* new AccessDenied({ status: 403, message: 'This Access application is not authorized.' })
    }
    const identity = yield* access
      .getIdentity()
      .pipe(Effect.mapError(() => new AccessDenied({ status: 503, message: 'Access identity could not be verified.' })))
    if (identity?.email === undefined || !Array.contains(settings.FLOWDECK_ACCESS_EMAILS, identity.email)) {
      return yield* new AccessDenied({ status: 403, message: 'This identity is not authorized.' })
    }
  })

/** Trust native Access admission, never a caller-supplied authentication header. */
export const authorizeFrontend = Effect.gen(function* () {
  const environment = yield* WorkerEnvironment
  const context = yield* WorkerExecutionContext
  return yield* authorizeAccess(environment, context.access)
})
