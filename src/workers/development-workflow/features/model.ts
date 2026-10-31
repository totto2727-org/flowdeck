import { Schema } from 'effect'

import { makePrefixedUUIDv4 } from '../../../features/identity/id'

export const { schema: CommandId, make: makeCommandId } = makePrefixedUUIDv4('command')
export type CommandId = typeof CommandId.Type
export const TurnRequest = Schema.Struct({
  commandId: CommandId,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
})
export type TurnRequest = typeof TurnRequest.Type

export const SessionId = Schema.Literal('1')
export type SessionId = typeof SessionId.Type

export const Session = Schema.Struct({
  sessionId: SessionId,
  model: Schema.String,
  status: Schema.Literals(['active', 'completed']),
})
export type Session = typeof Session.Type

export const TurnReceipt = Schema.Union([
  Schema.Struct({ commandId: CommandId, status: Schema.Literal('running') }),
  Schema.Struct({
    commandId: CommandId,
    status: Schema.Literal('completed'),
    text: Schema.String,
  }),
  Schema.Struct({
    commandId: CommandId,
    status: Schema.Literals(['failed', 'interrupted']),
    error: Schema.Literals(['sdk_failure', 'runtime_interrupted', 'output_limit']),
  }),
])
export type TurnReceipt = typeof TurnReceipt.Type
