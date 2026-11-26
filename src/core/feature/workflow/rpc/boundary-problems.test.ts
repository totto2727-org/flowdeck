import { live } from '@effect/vitest'
import { Array, Cause, Effect, Option, Result, Schema } from 'effect'
import { expect } from 'vite-plus/test'

import {
  Conflict,
  ExternalError,
  InvalidOperation,
  InvalidSnapshot,
  NotFound,
  StorageConflict,
} from '@/core/feature/workflow/domain/errors'

import {
  decodeStandard,
  decodeString,
  encodeChildFailure,
  encodePeer,
  encodeStandard,
  originalError,
  readInvalidReply,
  readRemoteFailure,
} from './boundary.fixture.ts'
import { Rfc9457ProblemDetailsSchema } from './problem.ts'
import type { Rfc9457ProblemDetails } from './problem.ts'

const schemaFailure = Effect.flip(decodeString(12))
const rejectedSql = originalError('private SQL')
const rejectedStorage = originalError('private storage')
const rejectedService = originalError('private service')
const rejectedUnknown = originalError('private unknown')
const isStandardProblem = Schema.is(Rfc9457ProblemDetailsSchema)
const problemsUrl = 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md'
const scenarios = [
  { input: Effect.succeed(new NotFound({ resource: 'private resource' })), status: 404 },
  { input: Effect.succeed(new Conflict({ message: 'private conflict' })), status: 409 },
  {
    input: Effect.succeed(new StorageConflict({ cause: rejectedSql, message: 'private conflict', operation: 'batch' })),
    status: 409,
  },
  { input: Effect.succeed(new InvalidOperation({ message: 'private operation' })), status: 409 },
  { input: Effect.succeed(new InvalidSnapshot({ message: 'private snapshot' })), status: 409 },
  {
    input: Effect.succeed(new ExternalError({ cause: rejectedStorage, kind: 'storage', operation: 'db' })),
    status: 500,
  },
  {
    input: Effect.succeed(new ExternalError({ cause: rejectedService, kind: 'service', operation: 'peer' })),
    status: 502,
  },
  { input: schemaFailure, status: 400 },
  { input: Effect.succeed(rejectedUnknown), status: 500 },
]

const decodeProblem = (wire: string): Effect.Effect<Rfc9457ProblemDetails, Schema.Json | Schema.SchemaError> =>
  decodeStandard(wire).pipe(Effect.flatMap((reply) => Effect.flip(Effect.fromResult(reply))))

live.each(scenarios)('emits a sanitized JSON problem with status $status', ({ input, status }) =>
  Effect.gen(function* () {
    const reported = yield* input
    const { entries, exit } = yield* encodeChildFailure(reported)
    const wire = yield* exit
    const decoded = yield* decodeProblem(wire)
    const peerWire = yield* encodeStandard(Result.fail(decoded))
    const standardPeer = yield* readRemoteFailure('standard peer', peerWire)
    expect(entries).toHaveLength(1)
    expect(wire).not.toContain('private')
    expect(decoded.status).toBe(status)
    expect(standardPeer).toMatchObject({ cause: decoded })
  }),
)

live.each(scenarios)(
  'reconstructs a fresh local problem with status $status and matches its origin log',
  ({ input, status }) =>
    Effect.gen(function* () {
      const reported = yield* input
      const { entries, exit } = yield* encodeChildFailure(reported)
      const wire = yield* exit
      const local = yield* readRemoteFailure('parent', wire)
      const entry = Array.getUnsafe(entries, 0)
      expect(local.operation).toBe('parent')
      expect(local.cause).toMatchObject({ status, type: `${problemsUrl}#${local.cause.title}` })
      expect(isStandardProblem(local.cause)).toBe(true)
      expect(entry.annotations).toMatchObject({ errorId: local.cause.instance, operation: 'child' })
    }),
)

live.each(scenarios)('omits private stack and cause details from local status $status', ({ input }) =>
  Effect.gen(function* () {
    const reported = yield* input
    const { exit } = yield* encodeChildFailure(reported)
    const wire = yield* exit
    const local = yield* readRemoteFailure('parent', wire)
    expect(local.cause).not.toHaveProperty('stack')
    expect(local.cause).not.toHaveProperty('cause')
    expect(local.stack).not.toContain('private')
  }),
)

const cyclicFailure = (): Readonly<{ original: Error; reported: ExternalError }> => {
  const original = originalError('private credentials')
  original.stack = 'Error: private credentials\n at childOnly (secret.ts:99:1)'
  original.cause = original
  const reported = new ExternalError({ cause: original, kind: 'storage', operation: 'query' })
  return { original, reported }
}

live('retains nested original stack and cyclic causes only in the origin log', () =>
  Effect.gen(function* () {
    const { original, reported } = cyclicFailure()
    const { entries, exit } = yield* encodeChildFailure(reported)
    const entry = Array.getUnsafe(entries, 0)
    const wire = yield* exit
    const local = yield* readRemoteFailure('parent', wire)
    expect(entries).toHaveLength(1)
    expect(Cause.findErrorOption(entry.cause)).toStrictEqual(Option.some(reported))
    expect(original.stack).toContain('childOnly')
    expect(wire).not.toMatch(/childOnly|credentials/u)
    expect(local.stack).not.toContain('childOnly')
  }),
)

const conflictProblem = Effect.gen(function* () {
  const { exit } = yield* encodeChildFailure(new Conflict({ message: 'private' }))
  const wire = yield* exit
  return yield* decodeProblem(wire)
})

live('strips unknown problem extensions from valid peer problems', () =>
  Effect.gen(function* () {
    const problem = yield* conflictProblem
    const peerProblem = Result.fail({ ...problem, future: { secret: 'private token' }, stack: 'private stack' })
    const peerWire = yield* encodePeer(peerProblem)
    const local = yield* readRemoteFailure('parent', peerWire)
    expect(local.cause).toStrictEqual(problem)
    expect(local.cause).not.toHaveProperty('stack')
    expect(local.cause).not.toHaveProperty('future')
  }),
)

live('rejects problem details with a non-UUID correlation instance', () =>
  Effect.gen(function* () {
    const problem = yield* conflictProblem
    const invalid = Result.fail({ ...problem, instance: 'urn:uuid:invalid' })
    const peerWire = yield* encodePeer(invalid)
    expect(yield* readInvalidReply(peerWire)).toBeInstanceOf(ExternalError)
  }),
)
