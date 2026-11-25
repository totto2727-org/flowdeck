import { Data } from 'effect'

export class ExternalError extends Data.TaggedError('ExternalError')<
  Readonly<{
    cause: unknown
    operation: string
    kind: 'storage' | 'service'
  }>
> {}
