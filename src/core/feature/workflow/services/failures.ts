import type { PlatformError, Schema } from 'effect'

import type {
  Conflict,
  ExternalError,
  InvalidOperation,
  InvalidSnapshot,
  NotFound,
  StorageConflict,
} from '@/core/feature/workflow/domain/errors'
import type { RemoteWorkerError } from '@/core/feature/workflow/rpc/problem'

/** Complete failure channel for workflow application operations and task adapters. */
export type WorkflowFailure =
  | NotFound
  | Conflict
  | StorageConflict
  | InvalidOperation
  | InvalidSnapshot
  | ExternalError
  | RemoteWorkerError
  | PlatformError.PlatformError
  | Schema.SchemaError
