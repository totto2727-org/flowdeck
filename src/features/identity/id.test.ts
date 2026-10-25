import { BrowserCrypto } from '@effect/platform-browser'
import { Effect, Schema } from 'effect'
import { TestCrypto } from 'effect/testing'
import { describe, expect, it } from 'vite-plus/test'

import { makePrefixedUUIDv4, UserDefinedId } from './id'

const uuid = '3d360c7a-4b1a-4df3-9633-861a220bf5b7'
const prefixes = ['run', 'execution', 'event', 'commit', 'command', 'repository']

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
    expect(() => Schema.decodeUnknownSync(UserDefinedId)(id)).toThrow()
    expect(() => Schema.encodeSync(UserDefinedId)(id)).toThrow()
  })
})

describe('prefixed cryptographic random identities', () => {
  it.each(['', '../run', 'two words', '日本語'])('rejects unsafe factory prefix %s at schema construction', (prefix) =>
    expect(() => makePrefixedUUIDv4(prefix)).toThrow(),
  )

  it('supports a caller-selected safe prefix without changing the factory', () => {
    const { schema } = makePrefixedUUIDv4('repository')
    expect(Schema.decodeUnknownSync(schema)(`repository_${uuid}`)).toBe(`repository_${uuid}`)
    expect(Schema.is(schema)(`run_${uuid}`)).toBe(false)
  })

  it('keeps factories independent and generates a fresh ID when their Effects are rerun', async () => {
    const repository = makePrefixedUUIDv4('repository')
    const task = makePrefixedUUIDv4('task')
    const nextRepository = repository.make
    const [first, second, taskId] = await Effect.runPromise(
      Effect.all([nextRepository, nextRepository, task.make]).pipe(Effect.provide(BrowserCrypto.layer)),
    )
    expect(first).not.toBe(second)
    expect(Schema.is(repository.schema)(first)).toBe(true)
    expect(Schema.is(repository.schema)(second)).toBe(true)
    expect(Schema.is(task.schema)(taskId)).toBe(true)
    expect(Schema.is(repository.schema)(taskId)).toBe(false)
    expect(Schema.is(task.schema)(first)).toBe(false)
  })

  it.each(prefixes)('round-trips %s and uses the official v4 check for its suffix', (kind) => {
    const { schema } = makePrefixedUUIDv4(kind)
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

  it.each(prefixes)('generates valid distinct %s IDs through the real Crypto layer', async (kind) => {
    const { schema, make } = makePrefixedUUIDv4(kind)
    const ids = await Effect.runPromise(Effect.all([make, make]).pipe(Effect.provide(BrowserCrypto.layer)))
    expect(ids[0]).not.toBe(ids[1])
    expect(Schema.is(schema)(ids[0])).toBe(true)
    expect(Schema.is(schema)(ids[1])).toBe(true)
  })

  it('uses the Crypto service supplied at execution time and supports deterministic TestCrypto', async () => {
    const { schema, make } = makePrefixedUUIDv4('test')
    const generate = Effect.all([make, make])
    const runWithSeed = (seed: string) =>
      Effect.runPromise(generate.pipe(Effect.provide(TestCrypto.layer(seed)), Effect.provide(BrowserCrypto.layer)))
    const first = await runWithSeed('first-seed')
    expect(await runWithSeed('first-seed')).toEqual(first)
    expect(await runWithSeed('other-seed')).not.toEqual(first)
    expect(first[0]).not.toBe(first[1])
    for (const id of first) expect(Schema.is(schema)(id)).toBe(true)
  })
})
