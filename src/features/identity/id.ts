import { Crypto, Effect, Schema } from 'effect'

/** ASCII deliberately excludes whitespace, path separators, controls and Unicode confusables. */
export const UserDefinedId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  // A fixed ASCII alphabet needs no per-character allocations. Unlike $, this end assertion rejects trailing newlines.
  Schema.isPattern(/^[A-Za-z0-9_-]+(?![\s\S])/),
)
export type UserDefinedId = typeof UserDefinedId.Type

export type RandomIdKind = 'run' | 'execution' | 'event' | 'commit' | 'command'

/** Validate the configured prefix once; the official schema validates prefix_UUIDv4 on both sides. */
export const makePrefixedUUIDv4 = (prefix: UserDefinedId) => {
  const fixedPrefix: string = `${Schema.decodeUnknownSync(UserDefinedId)(prefix)}_`
  return Schema.TemplateLiteral([fixedPrefix, Schema.String.check(Schema.isUUID(4))])
}
export type PrefixedUUIDv4 = ReturnType<typeof makePrefixedUUIDv4>['Type']

export const RunId = makePrefixedUUIDv4('run')
export type RunId = typeof RunId.Type
export const ExecutionId = makePrefixedUUIDv4('execution')
export type ExecutionId = typeof ExecutionId.Type
export const EventId = makePrefixedUUIDv4('event')
export type EventId = typeof EventId.Type
export const CommitId = makePrefixedUUIDv4('commit')
export type CommitId = typeof CommitId.Type
export const CommandId = makePrefixedUUIDv4('command')
export type CommandId = typeof CommandId.Type

const schemas = { run: RunId, execution: ExecutionId, event: EventId, commit: CommitId, command: CommandId }

/** Prefix identifies provenance, not time or authorization. Crypto owns secure randomness. */
export const randomId = (kind: RandomIdKind) =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.randomUUIDv4().pipe(
      // A failure here is a generator/schema programming defect, not invalid external input.
      Effect.flatMap((uuid) => Schema.decodeUnknownEffect(schemas[kind])(`${kind}_${uuid}`).pipe(Effect.orDie)),
    ),
  )
