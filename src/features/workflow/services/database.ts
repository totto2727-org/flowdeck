import type { QueryDatabaseClient } from 'alchemy/Cloudflare/D1'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Context, Effect, String } from 'effect'

import { ExternalError, StorageConflict } from '@/features/workflow/domain/errors'

export class WorkflowDatabase extends Context.Service<WorkflowDatabase, QueryDatabaseClient>()(
  'flowdeck/WorkflowDatabase',
) {}

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

// Alchemy's statement API declares RuntimeContext even though the selected
// QueryDatabaseBinding captures WorkerEnvironment at construction, and the
// native test client captures an already resolved D1 binding. Neither executor
// reads RuntimeContext while executing. The SDK's empty phantom Layer narrows
// that excess requirement, not a dependency injected per query. Root provision
// alone cannot narrow the returned Store signatures. Do not reuse this adapter
// for HTTP/deferred-binding clients that resolve their database at execution.
export const withD1BindingContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(RuntimeContext.phantom))
