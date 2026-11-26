import { live } from '@effect/vitest'
import { Array, Cause, Effect } from 'effect'
import { expect } from 'vite-plus/test'

import { Conflict, ExternalError, StorageConflict } from '@/core/feature/workflow/domain/errors'
import { rpcResponse, rpcResult } from '@/core/feature/workflow/rpc/boundary'
import { RemoteWorkerError } from '@/core/feature/workflow/rpc/problem'

import {
  capture,
  databaseError,
  errorWithFrame,
  executeQueryFrame,
  getRuns,
  originalError,
} from './operation-logging.fixture.ts'

const httpConflict = 409
const httpInternalServerError = 500

const childResponse = Effect.fn('flowdeck.test.childResponse')(function* (
  reported: Conflict | ExternalError | StorageConflict,
  operation: string,
) {
  const encoded = Effect.fail(reported).pipe(rpcResponse(operation))
  const child = yield* capture(encoded)
  const wire = yield* child.exit
  const local = yield* Effect.flip(rpcResult('read child result')(wire))
  if (!(local instanceof RemoteWorkerError)) {
    return yield* local
  }
  return { childEntries: child.entries, local, wire }
})

const storageFailure = (cause: Error): ExternalError =>
  new ExternalError({ cause, kind: 'storage', operation: 'persist run' })
const storageConflict = (cause: Error, message = cause.message): StorageConflict =>
  new StorageConflict({ cause, message, operation: 'persist run' })
const childStorageConflict = (cause: Error): StorageConflict => storageConflict(cause, 'flowdeck_conflict')

const childFailures = [
  { createFailure: storageFailure, kind: 'storage' },
  { createFailure: childStorageConflict, kind: 'conflict' },
]

live.each(childFailures)('logs the original $kind stack only at the child RPC boundary', ({ createFailure }) =>
  Effect.gen(function* () {
    const original = databaseError()
    const error = createFailure(original)
    const { childEntries, local, wire } = yield* childResponse(error, 'persist child run')
    expect(childEntries).toHaveLength(1)
    const entry = Array.getUnsafe(childEntries, 0)
    expect(Cause.pretty(entry.cause)).toContain(executeQueryFrame)
    expect(entry.annotations).toMatchObject({ errorId: local.cause.instance })
    expect(wire).not.toContain(original.message)
  }),
)

live.each(childFailures)('reconstructs the $kind failure without its child error', ({ createFailure }) =>
  Effect.gen(function* () {
    const error = createFailure(databaseError())
    const { local } = yield* childResponse(error, 'persist child run')
    expect(local).not.toBe(error)
    expect(local).not.toBeInstanceOf(error.constructor)
    expect(local.cause).not.toHaveProperty('stack')
    expect(local.cause).not.toHaveProperty('cause')
    expect(local.stack).not.toContain(executeQueryFrame)
  }),
)

live.each([
  new Conflict({ message: 'private domain conflict' }),
  storageConflict(originalError('private database constraint')),
])('returns the same sanitized HTTP conflict after RPC for %s', (reported) =>
  Effect.gen(function* () {
    const { childEntries, local } = yield* childResponse(reported, 'commit child run')
    const { entries, response } = yield* getRuns(() => Effect.fail(local))
    const entry = Array.getUnsafe(entries, 0)
    expect(response.status).toBe(httpConflict)
    const body: unknown = yield* Effect.promise(async () => response.json())
    expect(body).toStrictEqual({ error: 'Conflict', message: local.cause.detail })
    expect(entries).toMatchObject([{ cause: Cause.fail(local) }])
    expect(Cause.pretty(entry.cause)).not.toContain('private database constraint')
    expect(childEntries).toMatchObject([{ annotations: { errorId: local.cause.instance } }])
  }),
)

const controlFailure = (cause: Error): ExternalError =>
  new ExternalError({ cause, kind: 'storage', operation: 'list runs' })

live('translates a typed storage failure to a sanitized HTTP response', () =>
  Effect.gen(function* () {
    const error = controlFailure(originalError('private database failure'))
    const { response } = yield* getRuns(() => Effect.fail(error))
    const body: unknown = yield* Effect.promise(async () => response.json())
    expect(response.status).toBe(httpInternalServerError)
    expect(body).toStrictEqual({ error: 'ExternalError', message: 'Persistence operation failed' })
  }),
)

live.each([
  { description: 'typed failure', makeCause: Cause.fail<ExternalError> },
  { description: 'defect', makeCause: Cause.die },
])('logs a real Control request $description once with the original stack', ({ makeCause }) =>
  Effect.gen(function* () {
    const original = errorWithFrame('private database failure', executeQueryFrame)
    const cause = makeCause(controlFailure(original))
    const { entries, response } = yield* getRuns(() => Effect.failCause(cause))
    const entry = Array.getUnsafe(entries, 0)
    const firstError = Array.getUnsafe(Cause.prettyErrors(entry.cause), 0)
    expect(response.status).toBe(httpInternalServerError)
    expect(entries).toMatchObject([{ cause }])
    expect(firstError.cause).toHaveProperty('stack', original.stack)
  }),
)
