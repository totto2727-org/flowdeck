import type { WorkerExecutionContextAccess } from 'alchemy/Cloudflare/Workers'
import { Context, Data, Effect, Predicate } from 'effect'

import { HttpStatus } from '@/share/feature/http/status'

export class ExpectedAccessAudience extends Context.Service<ExpectedAccessAudience, Readonly<{ aud: string }>>()(
  'flowdeck/ExpectedAccessAudience',
) {}

export class AccessDenied extends Data.TaggedError('AccessDenied')<
  Readonly<{
    status: typeof HttpStatus.unauthorized | typeof HttpStatus.forbidden | typeof HttpStatus.serviceUnavailable
    message: string
  }>
> {}

/** Compare trusted platform admission with an already decoded, injected application audience. */
export const authorizeAccess = <R>(
  expected: ExpectedAccessAudience['Service'],
  admission: Effect.Effect<Pick<WorkerExecutionContextAccess, 'aud'> | undefined, never, R>,
): Effect.Effect<undefined, AccessDenied, R> =>
  Effect.gen(function* () {
    const access = yield* admission
    if (Predicate.isUndefined(access)) {
      return yield* new AccessDenied({
        status: HttpStatus.unauthorized,
        message: 'Cloudflare Access authentication is required.',
      })
    }
    if (access.aud !== expected.aud) {
      return yield* new AccessDenied({
        status: HttpStatus.forbidden,
        message: 'This Access application is not authorized.',
      })
    }
  })
