import type { WorkerExecutionContextAccess } from 'alchemy/Cloudflare/Workers'
import { Context, Data, Effect, Predicate } from 'effect'

export class ExpectedAccessAudience extends Context.Service<ExpectedAccessAudience, Readonly<{ aud: string }>>()(
  'flowdeck/ExpectedAccessAudience',
) {}

export class AccessDenied extends Data.TaggedError('AccessDenied')<
  Readonly<{
    status: 401 | 403 | 503
    message: string
  }>
> {}

/** Compare trusted platform admission with an already decoded, injected application audience. */
export const authorizeAccess = <R>(
  expected: ExpectedAccessAudience['Service'],
  admission: Effect.Effect<Pick<WorkerExecutionContextAccess, 'aud'> | undefined, never, R>,
) =>
  Effect.gen(function* () {
    const access = yield* admission
    if (Predicate.isUndefined(access)) {
      return yield* new AccessDenied({ status: 401, message: 'Cloudflare Access authentication is required.' })
    }
    if (access.aud !== expected.aud) {
      return yield* new AccessDenied({ status: 403, message: 'This Access application is not authorized.' })
    }
  })
