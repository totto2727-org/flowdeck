import { Data } from 'effect'

export class NotFound extends Data.TaggedError('NotFound')<
  Readonly<{
    resource: string
  }>
> {}
export class Conflict extends Data.TaggedError('Conflict')<
  Readonly<{
    message: string
  }>
> {}
export class StorageConflict extends Data.TaggedError('StorageConflict')<
  Readonly<{
    message: string
    operation: string
    cause: unknown
  }>
> {}
export class InvalidOperation extends Data.TaggedError('InvalidOperation')<
  Readonly<{
    message: string
  }>
> {}
export class InvalidSnapshot extends Data.TaggedError('InvalidSnapshot')<
  Readonly<{
    message: string
  }>
> {}
export class ExternalError extends Data.TaggedError('ExternalError')<
  Readonly<{
    cause: unknown
    operation: string
    kind: 'storage' | 'service'
  }>
> {}
