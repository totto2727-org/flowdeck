import { BrowserCrypto } from '@effect/platform-browser'
import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { randomId, makePrefixedUUIDv4, UserDefinedId, type RandomIdKind } from './id'

const uuid = '3d360c7a-4b1a-4df3-9633-861a220bf5b7'
const kinds: ReadonlyArray<RandomIdKind> = ['run', 'execution', 'event', 'commit', 'command']

describe('user-defined identities', () => {
  it.each(['demo', 'release-checkpoint', 'Review_42', 'a'.repeat(128)])('accepts safe ID %s', (id) => {
    expect(Schema.decodeUnknownSync(UserDefinedId)(id)).toBe(id)
  })

  it.each([
    '',
    '../run',
    'a/b',
    'a\\b',
    'two words',
    'a\n',
    'a\r\n',
    'a\u2028',
    'a\u2029',
    'a\u0000b',
    '日本語',
    'ｒun',
    'a'.repeat(129),
  ])('rejects unsafe ID %s without silently changing its identity', (id) =>
    expect(() => Schema.decodeUnknownSync(UserDefinedId)(id)).toThrow(),
  )
})

describe('prefixed cryptographic random identities', () => {
  it.each(['', '../run', 'two words', '日本語'])('rejects unsafe factory prefix %s at schema construction', (prefix) =>
    expect(() => makePrefixedUUIDv4(prefix)).toThrow(),
  )

  it('supports a caller-selected safe prefix without changing the factory', () => {
    const schema = makePrefixedUUIDv4('repository')
    expect(Schema.decodeUnknownSync(schema)(`repository_${uuid}`)).toBe(`repository_${uuid}`)
    expect(Schema.is(schema)(`run_${uuid}`)).toBe(false)
  })

  it.each(kinds)('round-trips %s and uses the official v4 check for its suffix', (kind) => {
    const schema = makePrefixedUUIDv4(kind)
    const id = `${kind}_${uuid}`
    expect(Schema.decodeUnknownSync(schema)(id)).toBe(id)
    expect(Schema.encodeSync(schema)(id)).toBe(id)
    for (const invalid of [
      uuid,
      `other_${uuid}`,
      `${id}_extra`,
      `${kind}_not-a-uuid`,
      `${kind}_3d360c7a-4b1a-1df3-9633-861a220bf5b7`,
      `${kind}_01890f2e-7b55-7cc1-8c5a-000000000001`,
    ]) {
      expect(Schema.is(schema)(invalid)).toBe(false)
      expect(() => Schema.decodeUnknownSync(schema)(invalid)).toThrow()
      expect(() => Schema.encodeSync(schema)(invalid)).toThrow()
    }
  })

  it.each(kinds)('generates valid distinct %s IDs through the real Crypto layer', async (kind) => {
    const ids = await Effect.runPromise(
      Effect.all([randomId(kind), randomId(kind)]).pipe(Effect.provide(BrowserCrypto.layer)),
    )
    expect(ids[0]).not.toBe(ids[1])
    expect(Schema.is(makePrefixedUUIDv4(kind))(ids[0])).toBe(true)
    expect(Schema.is(makePrefixedUUIDv4(kind))(ids[1])).toBe(true)
  })
})
