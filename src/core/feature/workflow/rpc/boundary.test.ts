import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { Array, Cause, Effect, Exit, Option, Result } from 'effect'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { ExternalError, NotFound } from '@/core/feature/workflow/domain/errors'

import {
  capture,
  decodeStandard,
  decodeString,
  encodeStandard,
  originalError,
  parse,
  readInvalidReply,
  readRemoteFailure,
} from './boundary.fixture.ts'
import { makeRpcResponse, rpcResponse, rpcResult } from './boundary.ts'
import { RemoteWorkerError } from './problem.ts'
import type { Rfc9457ProblemDetails } from './problem.ts'

live('captures Crypto at initialization and responds repeatedly without operation-level provision', () =>
  Effect.gen(function* () {
    const respond = yield* makeRpcResponse.pipe(Effect.provide(BrowserCrypto.layer))
    const operation = Effect.fail(new NotFound({ resource: 'private' }))
    const first = respond('first')(operation)
    expectTypeOf(first).toEqualTypeOf<Effect.Effect<string>>()
    const replies = Effect.all([first, respond('second')(operation)])
    const { exit } = yield* capture(replies)
    const [firstWire, secondWire] = yield* exit
    const [firstError, secondError] = yield* Effect.all([
      readRemoteFailure('parent', firstWire),
      readRemoteFailure('parent', secondWire),
    ])
    expect(firstError.cause.instance).not.toBe(secondError.cause.instance)
    expect([firstError.cause.status, secondError.cause.status]).toStrictEqual([404, 404])
  }),
)

// oxlint-disable-next-line unicorn/no-null -- Exercise a native JSON null round trip through the RPC wire format.
const payload = { nested: { answer: 42 }, values: [null, true, 12, 'hello'] }

live('round-trips JSON text without success logs', () =>
  Effect.gen(function* () {
    const operation = Effect.succeed(payload).pipe(rpcResponse('read'))
    const { entries, exit } = yield* capture(operation)
    const wire = yield* exit
    const parsed = yield* parse(wire)
    const value = yield* decodeStandard(wire).pipe(Effect.flatMap(Effect.fromResult))
    expect(wire).toBeTypeOf('string')
    expect(Result.isResult(parsed)).toBe(false)
    expect(value).toStrictEqual(payload)
    expect(yield* rpcResult('parent')(wire)).toStrictEqual(payload)
    expect(entries).toHaveLength(0)
  }),
)

live('accepts a success envelope from a standard JSON peer', () =>
  Effect.gen(function* () {
    const wire = yield* encodeStandard(Result.succeed(payload))
    expect(yield* rpcResult('standard peer')(wire)).toStrictEqual(payload)
  }),
)

const invalidCalls = (): RemoteWorkerError => {
  const nonJson = Effect.succeed(originalError('private'))
  // @ts-expect-error Error is not JSON.
  rpcResponse('invalid')(nonJson)
  // @ts-expect-error The validated remote cause is required.
  return new RemoteWorkerError({ operation: 'invalid' })
}

describe('public RPC types', () => {
  test('requires a validated problem cause and disallows non-JSON success types', () => {
    expectTypeOf<ConstructorParameters<typeof RemoteWorkerError>[0]>().toEqualTypeOf<
      Readonly<{
        cause: Rfc9457ProblemDetails
        operation: string
      }>
    >()
    expectTypeOf(invalidCalls).toBeFunction()
  })
})

const invalidInput = 12
const invalidOutput = Number.NaN

live('classifies invalid outbound JSON as an internal defect', () =>
  Effect.gen(function* () {
    const operation = Effect.succeed(invalidOutput).pipe(rpcResponse('encode output'))
    const { entries, exit } = yield* capture(operation)
    const wire = yield* exit
    const outgoing = yield* readRemoteFailure('parent', wire)
    expect(outgoing.cause).toMatchObject({ status: 500, title: 'internal' })
    expect(entries).toHaveLength(1)
    const entry = Array.getUnsafe(entries, 0)
    expect(Cause.hasDies(entry.cause)).toBe(true)
  }),
)

live('classifies failed input validation as an invalid request', () =>
  Effect.gen(function* () {
    const operation = decodeString(invalidInput).pipe(rpcResponse('decode input'))
    const { entries, exit } = yield* capture(operation)
    const wire = yield* exit
    const incoming = yield* readRemoteFailure('parent', wire)
    expect(incoming.cause).toMatchObject({ status: 400, title: 'invalid-request' })
    expect(entries).toHaveLength(1)
    const entry = Array.getUnsafe(entries, 0)
    expect(Cause.hasFails(entry.cause)).toBe(true)
  }),
)

live('sanitizes defects and success serialization defects', () =>
  Effect.gen(function* () {
    const failed = Effect.die(originalError('private defect')).pipe(rpcResponse('defect'))
    const defect = yield* capture(failed)
    expect(defect.entries).toHaveLength(1)
    expect(yield* defect.exit).not.toContain('private defect')
    const value = {
      get secret(): string {
        throw originalError('private serializer')
      },
    }
    const serialization = Effect.succeed(value).pipe(rpcResponse('serialize'))
    const serialized = yield* capture(serialization)
    expect(serialized.entries).toHaveLength(1)
    expect(yield* serialized.exit).not.toContain('private serializer')
  }),
)

live.each([
  'private token',
  '{"_tag":"Success","success":1,"secret":"private token"}',
  '{"_tag":"Success"}',
  '{"_tag":"Failure","failure":{"status":500,"detail":"private token"}}',
  '{"_tag":"Success","value":"private token"}',
  '{"_tag":"Failure","problem":{"status":500}}',
  Result.succeed('private token'),
  undefined,
])('rejects malformed or non-text envelopes without retaining peer bytes', (response) =>
  Effect.gen(function* () {
    const rejected = yield* readInvalidReply(response)
    expect(rejected).toBeInstanceOf(ExternalError)
    expect(rejected.kind).toBe('service')
    expect(rejected.cause).toBeInstanceOf(Error)
    expect(rejected.cause).toMatchObject({ message: 'Invalid RPC response' })
    expect(Cause.pretty(Cause.fail(rejected))).not.toContain('private token')
  }),
)

live('preserves interruption without logging or producing a reply', () =>
  Effect.gen(function* () {
    const operation = Effect.interrupt.pipe(rpcResponse('cancel'))
    const { entries, exit } = yield* capture(operation)
    const interruption = Option.getOrThrow(Exit.getCause(exit))
    expect(Cause.hasInterruptsOnly(interruption)).toBe(true)
    expect(entries).toHaveLength(0)
  }),
)

const encodeNextHop = Effect.gen(function* () {
  const childRun = Effect.fail(new NotFound({ resource: 'private' })).pipe(rpcResponse('child'))
  const child = yield* capture(childRun)
  const childWire = yield* child.exit
  const previous = yield* readRemoteFailure('call child', childWire)
  const operation = Effect.fail(previous).pipe(rpcResponse('parent'))
  const parent = yield* capture(operation)
  return { parent, previous }
})

live('creates fresh correlation IDs at each hop', () =>
  Effect.gen(function* () {
    const { parent, previous } = yield* encodeNextHop
    const parentWire = yield* parent.exit
    const grandparent = yield* readRemoteFailure('call parent', parentWire)
    expect(grandparent.cause.instance).not.toBe(previous.cause.instance)
    expect({ ...grandparent.cause, instance: previous.cause.instance }).toStrictEqual(previous.cause)
  }),
)

live('records the prior error ID only in the next origin log', () =>
  Effect.gen(function* () {
    const { parent, previous } = yield* encodeNextHop
    const parentWire = yield* parent.exit
    expect(parent.entries).toHaveLength(1)
    const entry = Array.getUnsafe(parent.entries, 0)
    expect(Cause.pretty(entry.cause)).toContain(previous.cause.instance)
    expect(yield* parse(parentWire)).not.toHaveProperty('stack')
  }),
)
