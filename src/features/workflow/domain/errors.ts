import { Data, type PlatformError, type Schema } from 'effect'

export class NotFound extends Data.TaggedError('NotFound')<{
  readonly resource: string
}> {}
export class Conflict extends Data.TaggedError('Conflict')<{
  readonly message: string
}> {}
export class InvalidOperation extends Data.TaggedError('InvalidOperation')<{
  readonly message: string
}> {}
export class InvalidSnapshot extends Data.TaggedError('InvalidSnapshot')<{
  readonly message: string
}> {}
export class ExternalError extends Data.TaggedError('ExternalError')<{
  readonly cause: unknown
  readonly operation: string
  readonly kind: 'storage' | 'service'
}> {}
export type DomainError =
  | NotFound
  | Conflict
  | InvalidOperation
  | InvalidSnapshot
  | ExternalError
  | PlatformError.PlatformError
  | Schema.SchemaError
