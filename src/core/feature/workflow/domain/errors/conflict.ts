import { Data } from 'effect'

export class Conflict extends Data.TaggedError('Conflict')<
  Readonly<{
    message: string
  }>
> {}
