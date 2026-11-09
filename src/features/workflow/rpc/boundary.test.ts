import { ok } from 'node:assert/strict'

import { Cause, Crypto, Effect, Exit, Logger, Option, References, Result, Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import {
  Conflict,
  ExternalError,
  InvalidOperation,
  InvalidSnapshot,
  NotFound,
  StorageConflict,
} from '@/features/workflow/domain/errors'

import { makeRpcResponse, rpcResponse, rpcResult } from './boundary'
import { RemoteWorkerError, Rfc9457ProblemDetails } from './problem'

const crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (_algorithm, bytes) => Effect.succeed(bytes),
})
const capture = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) => {
  const entries: Array<Logger.Options<unknown> & { readonly annotations: Readonly<Record<string, unknown>> }> = []
  const exit = Effect.runSyncExit(
    effect.pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provide(
        Logger.layer([
          Logger.make((entry) =>
            entries.push({ ...entry, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) }),
          ),
        ]),
      ),
    ),
  )
  return { entries, exit }
}
const success = <A, E>(exit: Exit.Exit<A, E>) => {
  ok(Exit.isSuccess(exit))
  return exit.value
}
const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  ok(Exit.isFailure(exit))
  return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const standardWire = Schema.fromJsonString(Schema.toCodecJson(Schema.Result(Schema.Json, Rfc9457ProblemDetails)))
const decodeStandard = Schema.decodeUnknownSync(standardWire, { onExcessProperty: 'error' })
const encodeStandard = Schema.encodeSync(standardWire, { onExcessProperty: 'error' })
const encodePeer = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Schema.Result(Schema.Json, Schema.Json))))

describe('JSON RPC boundary', () => {
  it('captures Crypto at initialization and responds repeatedly without operation-level provision', () => {
    const respond = Effect.runSync(makeRpcResponse.pipe(Effect.provideService(Crypto.Crypto, crypto)))
    const operation = Effect.fail(new NotFound({ resource: 'private' }))
    const first = respond('first')(operation)
    expectTypeOf(first).toEqualTypeOf<Effect.Effect<string>>()
    const texts = Effect.runSync(
      Effect.all([first, respond('second')(operation)]).pipe(
        Effect.provide(Logger.layer([Logger.make(() => undefined)])),
      ),
    )
    const firstError = failure(Effect.runSyncExit(rpcResult('parent')(texts[0])))
    const secondError = failure(Effect.runSyncExit(rpcResult('parent')(texts[1])))
    ok(firstError instanceof RemoteWorkerError)
    ok(secondError instanceof RemoteWorkerError)
    expect(firstError.cause.instance).not.toBe(secondError.cause.instance)
    expect(firstError.cause.status).toBe(404)
    expect(secondError.cause.status).toBe(404)
  })
  it('round-trips JSON text without success logs', () => {
    const value = { values: [null, true, 12, 'hello'], nested: { answer: 42 } }
    const { entries, exit } = capture(Effect.succeed(value).pipe(rpcResponse('read')))
    const text = success(exit)
    expect(typeof text).toBe('string')
    expect(Result.isResult(parse(text))).toBe(false)
    const decoded = decodeStandard(text)
    ok(Result.isSuccess(decoded))
    expect(decoded.success).toEqual(value)
    expect(Effect.runSync(rpcResult('standard peer')(encodeStandard(Result.succeed(value))))).toEqual(value)
    expect(Effect.runSync(rpcResult('parent')(text))).toEqual(value)
    expect(entries).toHaveLength(0)
  })

  it('requires a validated problem cause and disallows non-JSON success types', () => {
    expectTypeOf<ConstructorParameters<typeof RemoteWorkerError>[0]>().toEqualTypeOf<{
      readonly operation: string
      readonly cause: Rfc9457ProblemDetails
    }>()
    const invalidCalls = () => {
      // @ts-expect-error Error is not JSON.
      rpcResponse('invalid')(Effect.succeed(new Error('private')))
      // @ts-expect-error Required cause cannot be omitted.
      new RemoteWorkerError({ operation: 'invalid' })
    }
    expectTypeOf(invalidCalls).toBeFunction()
  })

  it.each([
    [new NotFound({ resource: 'private resource' }), 404],
    [new Conflict({ message: 'private conflict' }), 409],
    [new StorageConflict({ message: 'private conflict', operation: 'batch', cause: new Error('private SQL') }), 409],
    [new InvalidOperation({ message: 'private operation' }), 409],
    [new InvalidSnapshot({ message: 'private snapshot' }), 409],
    [new ExternalError({ operation: 'db', kind: 'storage', cause: new Error('private storage') }), 500],
    [new ExternalError({ operation: 'peer', kind: 'service', cause: new Error('private service') }), 502],
    [failure(Effect.runSyncExit(Schema.decodeUnknownEffect(Schema.String)(12))), 400],
    [new Error('private unknown'), 500],
  ] as const)('sanitizes %s into status %s and logs once', (error, status) => {
    const { entries, exit } = capture(Effect.fail(error).pipe(rpcResponse('child')))
    const text = success(exit)
    expect(entries).toHaveLength(1)
    expect(text).not.toContain('private')
    const decoded = decodeStandard(text)
    ok(Result.isFailure(decoded))
    expect(decoded.failure.status).toBe(status)
    const standardPeer = failure(
      Effect.runSyncExit(rpcResult('standard peer')(encodeStandard(Result.fail(decoded.failure)))),
    )
    expect(standardPeer).toMatchObject({ cause: decoded.failure })
    const local = failure(Effect.runSyncExit(rpcResult('parent')(text)))
    ok(local instanceof RemoteWorkerError)
    expect(local.operation).toBe('parent')
    expect(local.cause.type).toBe(
      `https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#${local.cause.title}`,
    )
    expect(local.cause.status).toBe(status)
    expect(Schema.is(Rfc9457ProblemDetails)(local.cause)).toBe(true)
    expect(local.cause).not.toHaveProperty('stack')
    expect(local.cause).not.toHaveProperty('cause')
    expect(local.stack).not.toContain('private')
    expect(entries[0]!.annotations).toMatchObject({ operation: 'child', errorId: local.cause.instance })
  })

  it('retains nested original stack and cyclic causes only in the origin log', () => {
    const original = new Error('private credentials')
    original.stack = 'Error: private credentials\n at childOnly (secret.ts:99:1)'
    original.cause = original
    const error = new ExternalError({ operation: 'query', kind: 'storage', cause: original })
    const { entries, exit } = capture(Effect.fail(error).pipe(rpcResponse('child')))
    expect(entries).toHaveLength(1)
    expect(Cause.findErrorOption(entries[0]!.cause)).toEqual(Option.some(error))
    expect(original.stack).toContain('childOnly')
    const text = success(exit)
    expect(text).not.toContain('childOnly')
    expect(text).not.toContain('credentials')
    const local = failure(Effect.runSyncExit(rpcResult('parent')(text)))
    expect(local.stack).not.toContain('childOnly')
  })

  it('classifies invalid outbound JSON as internal while preserving input validation as invalid request', () => {
    const outgoing = capture(Effect.succeed(Number.NaN).pipe(rpcResponse('encode output')))
    const outgoingError = failure(Effect.runSyncExit(rpcResult('parent')(success(outgoing.exit))))
    ok(outgoingError instanceof RemoteWorkerError)
    expect(outgoingError.cause.status).toBe(500)
    expect(outgoingError.cause.title).toBe('internal')
    expect(outgoing.entries).toHaveLength(1)
    expect(Cause.hasDies(outgoing.entries[0]!.cause)).toBe(true)
    const incoming = capture(Schema.decodeUnknownEffect(Schema.String)(12).pipe(rpcResponse('decode input')))
    const incomingError = failure(Effect.runSyncExit(rpcResult('parent')(success(incoming.exit))))
    ok(incomingError instanceof RemoteWorkerError)
    expect(incomingError.cause.status).toBe(400)
    expect(incomingError.cause.title).toBe('invalid-request')
    expect(incoming.entries).toHaveLength(1)
    expect(Cause.hasFails(incoming.entries[0]!.cause)).toBe(true)
  })

  it('sanitizes defects and success serialization defects', () => {
    const defect = capture(Effect.die(new Error('private defect')).pipe(rpcResponse('defect')))
    expect(defect.entries).toHaveLength(1)
    expect(success(defect.exit)).not.toContain('private defect')
    const value = {
      get secret(): string {
        throw new Error('private serializer')
      },
    }
    const serialized = capture(Effect.succeed(value).pipe(rpcResponse('serialize')))
    expect(serialized.entries).toHaveLength(1)
    expect(success(serialized.exit)).not.toContain('private serializer')
  })

  it.each([
    'private token',
    '{"_tag":"Success","success":1,"secret":"private token"}',
    '{"_tag":"Success"}',
    '{"_tag":"Failure","failure":{"status":500,"detail":"private token"}}',
    '{"_tag":"Success","value":"private token"}',
    '{"_tag":"Failure","problem":{"status":500}}',
    Result.succeed('private token'),
    undefined,
  ])('rejects malformed or non-text envelopes without retaining peer bytes', (response) => {
    const error = failure(Effect.runSyncExit(rpcResult('decode')(response)))
    ok(error instanceof ExternalError)
    expect(error.kind).toBe('service')
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause).toMatchObject({ message: 'Invalid RPC response' })
    expect(Cause.pretty(Cause.fail(error))).not.toContain('private token')
  })

  it('strips unknown problem extensions and rejects non-UUID correlation instances', () => {
    const text = success(capture(Effect.fail(new Conflict({ message: 'private' })).pipe(rpcResponse('child'))).exit)
    const reply = decodeStandard(text)
    ok(Result.isFailure(reply))
    const extended = failure(
      Effect.runSyncExit(
        rpcResult('parent')(
          encodePeer(Result.fail({ ...reply.failure, stack: 'private stack', future: { secret: 'private token' } })),
        ),
      ),
    )
    ok(extended instanceof RemoteWorkerError)
    expect(extended.cause).toEqual(reply.failure)
    expect(extended.cause).not.toHaveProperty('stack')
    expect(extended.cause).not.toHaveProperty('future')
    expect(
      failure(
        Effect.runSyncExit(
          rpcResult('parent')(encodePeer(Result.fail({ ...reply.failure, instance: 'urn:uuid:invalid' }))),
        ),
      ),
    ).toBeInstanceOf(ExternalError)
  })

  it('preserves interruption without logging or producing a reply', () => {
    const { entries, exit } = capture(Effect.interrupt.pipe(rpcResponse('cancel')))
    ok(Exit.isFailure(exit))
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(entries).toHaveLength(0)
  })

  it('creates fresh correlation IDs at each hop while logging the previous problem', () => {
    const child = capture(Effect.fail(new NotFound({ resource: 'private' })).pipe(rpcResponse('child')))
    const childText = success(child.exit)
    const parentError = failure(Effect.runSyncExit(rpcResult('call child')(childText)))
    ok(parentError instanceof RemoteWorkerError)
    const parent = capture(Effect.fail(parentError).pipe(rpcResponse('parent')))
    const grandparent = failure(Effect.runSyncExit(rpcResult('call parent')(success(parent.exit))))
    ok(grandparent instanceof RemoteWorkerError)
    expect(grandparent.cause.instance).not.toBe(parentError.cause.instance)
    expect({ ...grandparent.cause, instance: parentError.cause.instance }).toEqual(parentError.cause)
    expect(Cause.pretty(parent.entries[0]!.cause)).toContain(parentError.cause.instance)
    expect(parent.entries).toHaveLength(1)
    expect(parse(success(parent.exit))).not.toHaveProperty('stack')
  })
})
