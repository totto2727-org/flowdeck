import { Data, type PlatformError } from 'effect'

export class NotFound extends Data.TaggedError('NotFound')<{
  readonly resource: string
}> {}
export class Conflict extends Data.TaggedError('Conflict')<{
  readonly message: string
  readonly cause?: unknown
}> {}
export class InvalidOperation extends Data.TaggedError('InvalidOperation')<{
  readonly message: string
}> {}
export class InvalidSnapshot extends Data.TaggedError('InvalidSnapshot')<{
  readonly message: string
  readonly cause?: unknown
}> {}
export class StoreError extends Data.TaggedError('StoreError')<{
  readonly cause: unknown
  readonly operation: string
}> {}
export class BindingError extends Data.TaggedError('BindingError')<{
  readonly cause: unknown
}> {}
export type DomainError =
  | NotFound
  | Conflict
  | InvalidOperation
  | InvalidSnapshot
  | StoreError
  | BindingError
  | PlatformError.PlatformError
