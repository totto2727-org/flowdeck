import { Data } from 'effect'

export class ControlError extends Data.TaggedError('ControlError')<Readonly<{ message: string }>> {}
