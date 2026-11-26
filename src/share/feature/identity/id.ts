import { Crypto, Effect, Result, Schema } from 'effect'
import type { PlatformError } from 'effect'

const maxIdentifierLength = 128
const uuidVersion = 4

// ASCII deliberately excludes whitespace, path separators, controls and Unicode confusables.
// oxlint-disable-next-line eslint/no-redeclare -- Preserve the public schema and its Type under the same name.
export const UserDefinedId = Schema.String.check(
  Schema.isMaxLength(maxIdentifierLength),
  Schema.isTrimmed(),
  // A fixed ASCII alphabet is clearer as a character class; isTrimmed rejects trailing line terminators.
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
)
export type UserDefinedId = typeof UserDefinedId.Type

const decodeUserDefinedId = Schema.decodeResult(UserDefinedId)
const UUIDv4 = Schema.String.check(Schema.isUUID(uuidVersion))

type PrefixSchema = Schema.TemplateLiteral<Readonly<[string, typeof UUIDv4]>>
type Generator = () => Effect.Effect<PrefixSchema['Type'], PlatformError.PlatformError>
type PrefixFactory = Readonly<{
  make: Effect.Effect<PrefixSchema['Type'], PlatformError.PlatformError, Crypto.Crypto>
  makeGenerator: Effect.Effect<Generator, never, Crypto.Crypto>
  schema: PrefixSchema
}>

/**
 * Each prefix owns its schema and Crypto-backed factory.
 * @param {UserDefinedId} prefix The owner-defined ASCII prefix.
 * @returns {PrefixFactory} The fixed schema and the generators that implement it.
 */
export const makePrefixedUUIDv4 = (prefix: UserDefinedId): PrefixFactory => {
  const validPrefix = Result.getOrThrow(decodeUserDefinedId(prefix))
  const fixedPrefix = `${validPrefix}_`
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
  return { make, makeGenerator, schema }
}
export type PrefixedUUIDv4 = ReturnType<typeof makePrefixedUUIDv4>['schema']['Type']
