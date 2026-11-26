import type { WorkerExecutionContextAccess } from 'alchemy/Cloudflare/Workers'
import { Data, Effect, Predicate } from 'effect'

import { HttpStatus } from '@/share/feature/http/status'

type ExpectedAccessAudience = Readonly<{ aud: string }>

export class AccessDenied extends Data.TaggedError('AccessDenied')<
  Readonly<{
    status: typeof HttpStatus.unauthorized | typeof HttpStatus.forbidden | typeof HttpStatus.serviceUnavailable
    message: string
  }>
> {}

/**
 * Checks the trusted platform admission against the configured audience.
 * @param {ExpectedAccessAudience} expected The decoded audience for this application.
 * @param {Effect.Effect<Pick<WorkerExecutionContextAccess, 'aud'> | undefined, never, R>} admission The platform admission for the current request.
 * @returns {Effect.Effect<void, AccessDenied, R>} A checked failure if the request cannot enter this application.
 */
export const authorizeAccess = <R>(
  expected: ExpectedAccessAudience,
  admission: Effect.Effect<Pick<WorkerExecutionContextAccess, 'aud'> | undefined, never, R>,
): Effect.Effect<void, AccessDenied, R> =>
  Effect.flatMap(admission, (access) => {
    if (Predicate.isNullish(access)) {
      return Effect.fail(
        new AccessDenied({
          message: 'Cloudflare Access authentication is required.',
          status: HttpStatus.unauthorized,
        }),
      )
    }
    if (access.aud !== expected.aud) {
      return Effect.fail(
        new AccessDenied({
          message: 'This Access application is not authorized.',
          status: HttpStatus.forbidden,
        }),
      )
    }
    return Effect.void
  })
