import { Data } from 'effect'

export class StorageConflict extends Data.TaggedError('StorageConflict')<
  Readonly<{
    message: string
    operation: string
    cause: unknown
  }>
> {}
