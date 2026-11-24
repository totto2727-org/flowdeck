import { Effect, Predicate, String } from 'effect'

import { ExternalError, StorageConflict } from '@/core/feature/workflow/domain/errors'

const databaseFailure = (operation: string, cause: unknown): StorageConflict | ExternalError => {
  const message = Predicate.isError(cause) ? cause.message : 'Database operation failed'
  return String.includes('flowdeck_')(message) || String.includes('UNIQUE constraint')(message)
    ? new StorageConflict({ message, operation, cause })
    : new ExternalError({ operation, cause, kind: 'storage' })
}

export const execute = <A, E extends Readonly<{ cause: unknown }>, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, StorageConflict | ExternalError, R> =>
  effect.pipe(
    Effect.mapError((error) => databaseFailure(operation, error.cause)),
    Effect.catchDefect((cause) => Effect.fail(databaseFailure(operation, cause))),
  )
