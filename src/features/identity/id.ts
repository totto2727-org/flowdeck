import { Crypto, Effect, Schema } from 'effect'

/** ASCII deliberately excludes whitespace, path separators, controls and Unicode confusables. */
export const UserDefinedId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  // A fixed ASCII alphabet needs no per-character allocations. Unlike $, this end assertion rejects trailing newlines.
  Schema.isPattern(/^[A-Za-z0-9_-]+(?![\s\S])/),
)
export type UserDefinedId = typeof UserDefinedId.Type

const decodeUserDefinedId = Schema.decodeUnknownSync(UserDefinedId)
const UUIDv4 = Schema.String.check(Schema.isUUID(4))

/** Each prefix owns its schema and Crypto-backed factory, without a central registry of ID kinds. */
export const makePrefixedUUIDv4 = (prefix: UserDefinedId) => {
  const fixedPrefix = decodeUserDefinedId(prefix) + '_'
  const schema = Schema.TemplateLiteral([fixedPrefix, UUIDv4])
  const decode = Schema.decodeUnknownEffect(schema)
  const make = () =>
    Effect.flatMap(Crypto.Crypto, (crypto) =>
      crypto.randomUUIDv4().pipe(
        // A failure here is a generator/schema programming defect, not invalid external input.
        Effect.flatMap((uuid) => decode(fixedPrefix + uuid).pipe(Effect.orDie)),
      ),
    )
  return { schema, make }
}
export type PrefixedUUIDv4 = ReturnType<typeof makePrefixedUUIDv4>['schema']['Type']
