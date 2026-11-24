import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'
import { TestCrypto } from 'effect/testing'
import { describe, expect, test } from 'vite-plus/test'

import { makePrefixedUUIDv4, UserDefinedId } from './id.ts'

const decodeUserDefinedId = Schema.decodeResult(UserDefinedId)
const encodeUserDefinedId = Schema.encodeResult(UserDefinedId)

const uuid = '3d360c7a-4b1a-4df3-9633-861a220bf5b7'
const prefixes = ['run', 'execution', 'event', 'commit', 'command', 'repository']
const repository = makePrefixedUUIDv4('repository')
const decodeRepositoryId = Schema.decodeResult(repository.schema)

const makeIdentityCase = (kind: string) => {
  const identity = makePrefixedUUIDv4(kind)
  // oxlint-disable-next-line rules/require-top-level-decoder -- Cache the decoder once per caller-selected prefix.
  const decode = Schema.decodeResult(identity.schema)
  const encode = Schema.encodeResult(identity.schema)
  return { decode, encode, identity, kind }
}

const identityCases = prefixes.map(makeIdentityCase)

describe('user-defined identities', () => {
  test.each(['demo', 'release-checkpoint', 'Review_42', 'a'.repeat(128)])('accepts safe ID %s', (id) => {
    expect(decodeUserDefinedId(id)).toStrictEqual(Result.succeed(id))
  })

  test.each([
    '',
    '../run',
    'a/b',
    'a\\b',
    'two words',
    ' run',
    'run ',
    '\trun',
    'run\t',
    '\u00a0run',
    'run\u00a0',
    'a\n',
    'a\r\n',
    'a\u2028',
    'a\u2029',
    'a\u0000b',
    '日本語',
    'ｒun',
    'a'.repeat(129),
  ])('rejects unsafe ID %s without silently changing its identity', (id) => {
    expect(Schema.is(UserDefinedId)(id)).toBe(false)
    expect([decodeUserDefinedId(id), encodeUserDefinedId(id)].map(Result.isFailure)).toStrictEqual([true, true])
  })
})

describe('prefixed cryptographic random identities', () => {
  test.each(['', '../run', 'two words', '日本語'])(
    'rejects unsafe factory prefix %s at schema construction',
    (prefix) => expect(() => makePrefixedUUIDv4(prefix)).toThrow(),
  )

  test('supports a caller-selected safe prefix without changing the factory', () => {
    const id = `repository_${uuid}`
    expect(decodeRepositoryId(id)).toStrictEqual(Result.succeed(id))
    expect(Schema.is(repository.schema)(`run_${uuid}`)).toBe(false)
  })

  live('keeps factories independent and generates a fresh ID when their Effects are rerun', () =>
    Effect.gen(function* () {
      const task = makePrefixedUUIDv4('task')
      const nextRepository = repository.make
      const [first, second, taskId] = yield* Effect.all([nextRepository, nextRepository, task.make]).pipe(
        Effect.provide(BrowserCrypto.layer),
      )
      expect(first).not.toBe(second)
      expect(Schema.is(repository.schema)(first)).toBe(true)
      expect(Schema.is(repository.schema)(second)).toBe(true)
      expect(Schema.is(task.schema)(taskId)).toBe(true)
      expect(Schema.is(repository.schema)(taskId)).toBe(false)
      expect(Schema.is(task.schema)(first)).toBe(false)
    }),
  )

  test.each(identityCases)('round-trips $kind and uses the official v4 check for its suffix', (scenario) => {
    const { decode, encode, identity, kind } = scenario
    const id = `${kind}_${uuid}`
    expect([decode(id), encode(id)]).toStrictEqual([Result.succeed(id), Result.succeed(id)])
    const acceptsId = Schema.is(identity.schema)
    const invalidIds = [
      uuid,
      `other_${uuid}`,
      `${id}_extra`,
      `${kind}_not-a-uuid`,
      `${kind}_3d360c7a-4b1a-1df3-9633-861a220bf5b7`,
      `${kind}_01890f2e-7b55-7cc1-8c5a-000000000001`,
    ]
    expect(invalidIds.filter(acceptsId)).toStrictEqual([])
    expect(invalidIds.filter((invalid) => Result.isSuccess(decode(invalid)))).toStrictEqual([])
    expect(invalidIds.filter((invalid) => Result.isSuccess(encode(invalid)))).toStrictEqual([])
  })

  live.each(prefixes)('generates valid distinct %s IDs through the real Crypto layer', (kind) =>
    Effect.gen(function* () {
      const { schema, make } = makePrefixedUUIDv4(kind)
      const [first, second] = yield* Effect.all([make, make]).pipe(Effect.provide(BrowserCrypto.layer))
      expect(first).not.toBe(second)
      expect([first, second].every(Schema.is(schema))).toBe(true)
    }),
  )

  live.each(identityCases)('keeps the constructed $kind generator usable without a caller Crypto service', (scenario) =>
    Effect.gen(function* () {
      const { decode, encode, identity } = scenario
      const { makeGenerator } = identity
      const generate = yield* makeGenerator.pipe(Effect.provide(BrowserCrypto.layer))
      const first = yield* generate()
      const second = yield* generate()
      expect(first).not.toBe(second)
      expect([decode(first), decode(second), encode(first), encode(second)]).toStrictEqual([
        Result.succeed(first),
        Result.succeed(second),
        Result.succeed(first),
        Result.succeed(second),
      ])
    }),
  )

  live('uses the Crypto service supplied at execution time and supports deterministic TestCrypto', () =>
    Effect.gen(function* () {
      const { schema, make } = makePrefixedUUIDv4('test')
      const generate = Effect.all([make, make])
      const runWithSeed = (seed: string) =>
        generate.pipe(Effect.provide(TestCrypto.layer(seed)), Effect.provide(BrowserCrypto.layer))
      const [first, sameSeed, otherSeed] = yield* Effect.all([
        runWithSeed('first-seed'),
        runWithSeed('first-seed'),
        runWithSeed('other-seed'),
      ])
      expect(sameSeed).toStrictEqual(first)
      expect(otherSeed).not.toStrictEqual(first)
      expect(first[0]).not.toBe(first[1])
      expect(first.every(Schema.is(schema))).toBe(true)
    }),
  )
})
