import { live } from '@effect/vitest'
import { Array, Cause, Effect, Exit } from 'effect'
import { HttpServerResponse } from 'effect/http'
import { expect } from 'vite-plus/test'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { operationFailureLogging } from '@/share/feature/operation-logging'

import type { CapturedOperation } from './operation-logging.fixture.ts'
import { capture, databaseError, executeQueryFrame, originalError } from './operation-logging.fixture.ts'

const failure = (original: Error): ExternalError =>
  new ExternalError({ cause: original, kind: 'storage', operation: 'persist run' })
const logFailure = (
  cause: Cause.Cause<unknown>,
): Effect.Effect<CapturedOperation<HttpServerResponse.HttpServerResponse, unknown>> =>
  capture(Effect.failCause(cause).pipe(operationFailureLogging))
const interrupted = Cause.interrupt(123)
const badGateway = HttpServerResponse.empty({ status: 502 })

live('logs a nested external error once without changing the failure', () =>
  Effect.gen(function* () {
    const original = databaseError()
    const cause = Cause.fail(failure(original))
    const { entries, exit } = yield* logFailure(cause)
    expect(exit).toStrictEqual(Exit.failCause(cause))
    expect(entries).toHaveLength(1)
    const entry = Array.getUnsafe(entries, 0)
    expect(entry).toMatchObject({ logLevel: 'Error', message: ['HTTP operation failed'] })
    expect(entry.cause).toBe(cause)
  }),
)

live('retains the original cause and stack in the failure log', () =>
  Effect.gen(function* () {
    const original = databaseError()
    const error = failure(original)
    const { entries } = yield* logFailure(Cause.fail(error))
    const entry = Array.getUnsafe(entries, 0)
    const firstError = Array.getUnsafe(Cause.prettyErrors(entry.cause), 0)
    expect(firstError.cause).toHaveProperty('stack', original.stack)
    expect(Cause.pretty(entry.cause)).toContain(executeQueryFrame)
    expect(error.cause).toBe(original)
  }),
)

live('logs before response translation without adding a second failure log', () =>
  Effect.gen(function* () {
    const cause = originalError('offline')
    const error = new ExternalError({ cause, kind: 'service', operation: 'call worker' })
    const operation = Effect.fail(error).pipe(
      operationFailureLogging,
      Effect.catchTag('ExternalError', () => Effect.succeed(badGateway)),
    )
    const { entries, exit } = yield* capture(operation)
    expect(exit).toStrictEqual(Exit.succeed(badGateway))
    expect(entries).toMatchObject([{ cause: Cause.fail(error) }])
  }),
)

live('returns successful results without logging', () =>
  Effect.gen(function* () {
    const response = HttpServerResponse.text('persisted')
    const operation = Effect.succeed(response).pipe(operationFailureLogging)
    const { entries, exit } = yield* capture(operation)
    expect(exit).toStrictEqual(Exit.succeed(response))
    expect(entries).toStrictEqual([])
  }),
)

live('leaves expected interruption unchanged without an error log', () =>
  Effect.gen(function* () {
    const { entries, exit } = yield* logFailure(interrupted)
    expect(exit).toStrictEqual(Exit.failCause(interrupted))
    expect(entries).toStrictEqual([])
  }),
)

const defect = Cause.die(originalError('runtime defect'))

live.each([
  { cause: Cause.die(originalError('unexpected runtime defect')), description: 'a native defect' },
  {
    cause: Cause.combine(defect, interrupted),
    description: 'a defect mixed with interruption',
  },
])('logs $description without changing the cause', ({ cause }) =>
  Effect.gen(function* () {
    const { entries, exit } = yield* logFailure(cause)
    expect(exit).toStrictEqual(Exit.failCause(cause))
    expect(entries).toHaveLength(1)
    expect(Array.getUnsafe(entries, 0).cause).toBe(cause)
  }),
)
