import { Schema } from 'effect'

import { makePrefixedUUIDv4 } from '@/share/feature/identity/id'

const maxPromptLength = 32_768

export const {
  make: makeCommandId,
  makeGenerator: makeCommandIdGenerator,
  // oxlint-disable-next-line eslint/no-redeclare -- The schema and its Type share the public name.
  schema: CommandId,
} = makePrefixedUUIDv4('command')
export type CommandId = typeof CommandId.Type
// oxlint-disable-next-line eslint/no-redeclare -- The schema and its Type share the public name.
export const TurnRequest = Schema.Struct({
  commandId: CommandId,
  prompt: Schema.NonEmptyString.check(Schema.isMaxLength(maxPromptLength)),
})
export type TurnRequest = typeof TurnRequest.Type

// oxlint-disable-next-line eslint/no-redeclare -- The schema and its Type share the public name.
export const SessionId = Schema.Literal('1')
export type SessionId = typeof SessionId.Type

// oxlint-disable-next-line eslint/no-redeclare -- The schema and its Type share the public name.
export const Session = Schema.Struct({
  model: Schema.String,
  sessionId: SessionId,
  status: Schema.Literals(['active', 'completed']),
})
export type Session = typeof Session.Type

// oxlint-disable-next-line eslint/no-redeclare -- The schema and its Type share the public name.
export const TurnReceipt = Schema.Union([
  Schema.Struct({ commandId: CommandId, status: Schema.Literal('running') }),
  Schema.Struct({
    commandId: CommandId,
    status: Schema.Literal('completed'),
    text: Schema.String,
  }),
  Schema.Struct({
    commandId: CommandId,
    error: Schema.Literals(['sdk_failure', 'runtime_interrupted', 'output_limit']),
    status: Schema.Literals(['failed', 'interrupted']),
  }),
])
export type TurnReceipt = typeof TurnReceipt.Type
