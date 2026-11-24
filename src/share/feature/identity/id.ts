import { Crypto, Effect, Result, Schema } from 'effect'

/** ASCII deliberately excludes whitespace, path separators, controls and Unicode confusables. */
export const UserDefinedId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isTrimmed(),
  // A fixed ASCII alphabet is clearer as a character class; isTrimmed rejects trailing line terminators.
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
)
export type UserDefinedId = typeof UserDefinedId.Type

const decodeUserDefinedId = Schema.decodeResult(UserDefinedId)
const UUIDv4 = Schema.String.check(Schema.isUUID(4))

/** Each prefix owns its schema and Crypto-backed factory, without a central registry of ID kinds. */
export const makePrefixedUUIDv4 = (prefix: UserDefinedId) => {
  const validPrefix = Result.getOrThrow(decodeUserDefinedId(prefix))
  const fixedPrefix: string = `${validPrefix}_`
  const schema = Schema.TemplateLiteral([fixedPrefix, UUIDv4])
  // oxlint-disable-next-line rules/require-top-level-decoder -- Build the decoder once for each caller-provided prefix.
  const decode = Schema.decodeEffect(schema)
  const makeGenerator = Effect.map(Crypto.Crypto, (crypto) =>
    Effect.fn('Identity.makePrefixedUUIDv4')(function* () {
      const uuid = yield* crypto.randomUUIDv4()
      // A failure here is a generator/schema programming defect, not invalid external input.
      return yield* decode(`${fixedPrefix}${uuid}`).pipe(Effect.orDie)
    }),
  )
  const make = Effect.flatMap(makeGenerator, (generate) => generate())
  return { schema, make, makeGenerator }
}
export type PrefixedUUIDv4 = ReturnType<typeof makePrefixedUUIDv4>['schema']['Type']
