import type { WorkerExecutionContextAccess } from 'alchemy/Cloudflare/Workers'
import { Context, Data, Effect } from 'effect'

export class ExpectedAccessAudience extends Context.Service<ExpectedAccessAudience, { readonly aud: string }>()(
  'flowdeck/ExpectedAccessAudience',
) {}

export class AccessDenied extends Data.TaggedError('AccessDenied')<{
  readonly status: 401 | 403 | 503
  readonly message: string
}> {}

/** Compare trusted platform admission with an already decoded, injected application audience. */
export const authorizeAccess = <R>(
  expected: ExpectedAccessAudience['Service'],
  admission: Effect.Effect<Pick<WorkerExecutionContextAccess, 'aud'> | undefined, never, R>,
) =>
  Effect.gen(function* () {
    const access = yield* admission
    if (access === undefined) {
      return yield* new AccessDenied({ status: 401, message: 'Cloudflare Access authentication is required.' })
    }
    if (access.aud !== expected.aud) {
      return yield* new AccessDenied({ status: 403, message: 'This Access application is not authorized.' })
    }
  })
