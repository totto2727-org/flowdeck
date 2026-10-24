import { WorkerEnvironment, WorkerExecutionContext } from 'alchemy/Cloudflare/Workers'
import { Array, Context, Data, Effect, Layer, Schema } from 'effect'

const AccessEnvironment = Schema.Struct({
  FLOWDECK_ACCESS_AUD: Schema.String.check(Schema.isMinLength(1)),
  FLOWDECK_ACCESS_EMAILS: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
})

export class AccessDenied extends Data.TaggedError('AccessDenied')<{
  readonly status: 401 | 403 | 503
  readonly message: string
}> {}

interface AccessAdmission<R> {
  readonly aud: string
  // The native Access identity is decoded at this platform boundary before use.
  readonly getIdentity: () => Effect.Effect<unknown, unknown, R>
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
    const access = yield* admission
    if (access === undefined) {
      return yield* new AccessDenied({ status: 401, message: 'Cloudflare Access authentication is required.' })
    }
    if (access.aud !== settings.FLOWDECK_ACCESS_AUD) {
      return yield* new AccessDenied({ status: 403, message: 'This Access application is not authorized.' })
    }
    const identity = yield* access.getIdentity().pipe(
      Effect.mapError(() => new AccessDenied({ status: 503, message: 'Access identity could not be verified.' })),
      Effect.flatMap((identity) =>
        Schema.decodeUnknownEffect(Schema.Struct({ email: Schema.String }))(identity).pipe(
          Effect.mapError(() => new AccessDenied({ status: 403, message: 'This identity is not authorized.' })),
        ),
      ),
    )
    if (!Array.contains(settings.FLOWDECK_ACCESS_EMAILS, identity.email)) {
      return yield* new AccessDenied({ status: 403, message: 'This identity is not authorized.' })
    }
  })

/** Trust native Access admission, never a caller-supplied authentication header. */
const authorizeFrontend = Effect.gen(function* () {
  const environment = yield* WorkerEnvironment
  const context = yield* WorkerExecutionContext
  return yield* authorizeAccess(environment, context.access)
})

export class FrontendAuthorization extends Context.Service<
  FrontendAuthorization,
  { readonly authorize: typeof authorizeFrontend }
>()('flowdeck/FrontendAuthorization') {}

export const AccessAuthorization = Layer.succeed(FrontendAuthorization, { authorize: authorizeFrontend })
export const LocalAuthorization = Layer.succeed(FrontendAuthorization, { authorize: Effect.succeed(undefined) })
