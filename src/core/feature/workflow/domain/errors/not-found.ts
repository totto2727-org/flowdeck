import { Data } from 'effect'

export class NotFound extends Data.TaggedError('NotFound')<
  Readonly<{
    resource: string
  }>
> {}
