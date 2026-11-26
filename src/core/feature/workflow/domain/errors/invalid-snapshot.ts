import { Data } from 'effect'

export class InvalidSnapshot extends Data.TaggedError('InvalidSnapshot')<
  Readonly<{
    message: string
  }>
> {}
