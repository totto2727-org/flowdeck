import { Data } from 'effect'

export class InvalidOperation extends Data.TaggedError('InvalidOperation')<
  Readonly<{
    message: string
  }>
> {}
