import { Effect, String } from 'effect'

import { ExternalError, StorageConflict } from '@/features/workflow/domain/errors'

const databaseFailure = (operation: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : 'Database operation failed'
  return String.includes('flowdeck_')(message) || String.includes('UNIQUE constraint')(message)
    ? new StorageConflict({ message, operation, cause })
    : new ExternalError({ operation, cause, kind: 'storage' })
}

export const execute = <A, E extends { readonly cause: unknown }, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.mapError((error) => databaseFailure(operation, error.cause)),
    Effect.catchDefect((cause) => Effect.fail(databaseFailure(operation, cause))),
  )
