import { ok } from 'node:assert/strict'

import { Cause, Context, Crypto, Effect, Exit, Layer, Logger, Option, References } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect, it } from 'vite-plus/test'

import { ApiRoutes } from '@/workers/control/features/router'

import { operationFailureLogging } from './operation-logging'
import { rpcResponse, rpcResult } from './rpc-boundary'
import { RemoteWorkerError } from './rpc-problem'
import { Conflict, ExternalError, StorageConflict } from './workflow/domain/errors'
import { Workflows } from './workflow/services/workflows'

const crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (_algorithm, bytes) => Effect.succeed(bytes),
})
const capture = <A, E>(effect: Effect.Effect<A, E, HttpServerRequest.HttpServerRequest | Crypto.Crypto>) => {
  const entries: Array<Logger.Options<unknown> & { readonly annotations: Readonly<Record<string, unknown>> }> = []
  const logger = Logger.make((entry) =>
    entries.push({ ...entry, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) }),
  )
  const exit = Effect.runSyncExit(
    effect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request('http://localhost/')),
      ),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provide(Logger.layer([logger])),
    ),
  )
  return { entries, exit }
}

describe('operation failure logging', () => {
  it.each(['storage', 'conflict'] as const)('logs the original %s stack only at the child RPC boundary', (kind) => {
    const original = new Error('D1 execution failed')
    original.stack = 'Error: D1 execution failed\n    at executeQuery (database.ts:42:7)'
    const error =
      kind === 'storage'
        ? new ExternalError({ operation: 'persist run', kind: 'storage', cause: original })
        : new StorageConflict({ message: 'flowdeck_conflict', operation: 'persist run', cause: original })
    const { entries, exit } = capture(Effect.fail(error).pipe(rpcResponse('persist child run')))
    ok(Exit.isSuccess(exit))
    expect(entries).toHaveLength(1)
    expect(Cause.pretty(entries[0]!.cause)).toContain('at executeQuery (database.ts:42:7)')
    const parent = Effect.runSyncExit(rpcResult('read child result')(exit.value))
    ok(Exit.isFailure(parent))
    const local = Option.getOrThrow(Cause.findErrorOption(parent.cause))
    ok(local instanceof RemoteWorkerError)
    expect(local).not.toBe(error)
    expect(local).not.toBeInstanceOf(error.constructor)
    expect(local.cause).not.toHaveProperty('stack')
    expect(local.cause).not.toHaveProperty('cause')
    expect(local.stack).not.toContain('at executeQuery (database.ts:42:7)')
    expect(exit.value).not.toContain('D1 execution failed')
    expect(entries[0]!.annotations).toMatchObject({ errorId: local.cause.instance })
  })
  it.each(['domain', 'storage'] as const)(
    'returns the same sanitized HTTP conflict after RPC for a %s conflict',
    async (kind) => {
      const original = new Error('private database constraint')
      const error =
        kind === 'domain'
          ? new Conflict({ message: 'private domain conflict' })
          : new StorageConflict({ message: original.message, operation: 'batch', cause: original })
      const child = capture(Effect.fail(error).pipe(rpcResponse('commit child run')))
      ok(Exit.isSuccess(child.exit))
      const parent = Effect.runSyncExit(rpcResult('read child result')(child.exit.value))
      ok(Exit.isFailure(parent))
      const local = Option.getOrThrow(Cause.findErrorOption(parent.cause))
      ok(local instanceof RemoteWorkerError)
      const unavailable = () => Effect.fail(local)
      const workflows: Workflows['Service'] = {
        listWorkflows: unavailable,
        listRuns: unavailable,
        getRunDetail: unavailable,
        createRun: unavailable,
        resumeRun: unavailable,
      }
      const entries: Array<Logger.Options<unknown>> = []
      const logger = Logger.make((entry) => entries.push(entry))
      const handler = HttpRouter.toWebHandler(
        ApiRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(Workflows, workflows))),
      )
      try {
        const response = await handler.handler(
          new Request('http://localhost/api/runs'),
          Context.make(Logger.CurrentLoggers, new Set([logger])),
        )
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
          error: 'Conflict',
          message: local.cause.detail,
        })
        expect(entries).toHaveLength(1)
        expect(child.entries).toHaveLength(1)
        expect(entries[0]?.cause).toEqual(Cause.fail(local))
        expect(Cause.pretty(entries[0]!.cause)).not.toContain('private database constraint')
        expect(child.entries[0]!.annotations).toMatchObject({ errorId: local.cause.instance })
      } finally {
        await handler.dispose()
      }
    },
  )
  it.each(['typed failure', 'defect'] as const)(
    'logs a real Control request %s once with the original stack',
    async (failure) => {
      const original = new Error('private database failure')
      const error = new ExternalError({ operation: 'list runs', kind: 'storage', cause: original })
      const unavailable = () => (failure === 'typed failure' ? Effect.fail(error) : Effect.die(error))
      const workflows: Workflows['Service'] = {
        listWorkflows: unavailable,
        listRuns: unavailable,
        getRunDetail: unavailable,
        createRun: unavailable,
        resumeRun: unavailable,
      }
      const entries: Array<Logger.Options<unknown>> = []
      const logger = Logger.make((entry) => entries.push(entry))
      const handler = HttpRouter.toWebHandler(
        ApiRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(Workflows, workflows))),
      )
      try {
        const response = await handler.handler(
          new Request('http://localhost/api/runs'),
          Context.make(Logger.CurrentLoggers, new Set([logger])),
        )
        expect(response.status).toBe(500)
        if (failure === 'typed failure') {
          expect(await response.json()).toEqual({ error: 'ExternalError', message: 'Persistence operation failed' })
        }
        expect(entries).toHaveLength(1)
        expect(entries[0]?.cause).toEqual(failure === 'typed failure' ? Cause.fail(error) : Cause.die(error))
        expect(Cause.prettyErrors(entries[0]!.cause)[0]?.cause).toMatchObject({ stack: original.stack })
      } finally {
        await handler.dispose()
      }
    },
  )

  it('logs a nested external error once with its original cause and stack, without changing the failure', () => {
    const original = new Error('D1 execution failed')
    original.stack = 'Error: D1 execution failed\n    at executeQuery (database.ts:42:7)'
    const error = new ExternalError({ operation: 'persist run', kind: 'storage', cause: original })
    const cause = Cause.fail(error)
    const { entries, exit } = capture(Effect.failCause(cause).pipe(operationFailureLogging))

    expect(exit).toEqual(Exit.failCause(cause))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.logLevel).toBe('Error')
    expect(entries[0]?.message).toEqual(['HTTP operation failed'])
    expect(entries[0]?.cause).toBe(cause)
    expect(Cause.prettyErrors(entries[0]!.cause)[0]?.cause).toMatchObject({ stack: original.stack })
    expect(Cause.pretty(entries[0]!.cause)).toContain('at executeQuery (database.ts:42:7)')
    expect(error.cause).toBe(original)
  })

  it('logs before response translation without adding a second failure log', () => {
    const error = new ExternalError({ operation: 'call worker', kind: 'service', cause: new Error('offline') })
    const { entries, exit } = capture(
      Effect.fail(error).pipe(
        operationFailureLogging,
        Effect.catchTag('ExternalError', () => Effect.succeed(HttpServerResponse.empty({ status: 502 }))),
      ),
    )

    expect(exit).toEqual(Exit.succeed(HttpServerResponse.empty({ status: 502 })))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.cause).toEqual(Cause.fail(error))
  })

  it('returns successful results without logging', () => {
    const { entries, exit } = capture(
      Effect.succeed(HttpServerResponse.text('persisted')).pipe(operationFailureLogging),
    )

    expect(exit).toEqual(Exit.succeed(HttpServerResponse.text('persisted')))
    expect(entries).toEqual([])
  })

  it('leaves expected interruption unchanged without an error log', () => {
    const cause = Cause.interrupt(123)
    const { entries, exit } = capture(Effect.failCause(cause).pipe(operationFailureLogging))

    expect(exit).toEqual(Exit.failCause(cause))
    expect(entries).toEqual([])
  })

  it('logs defects without converting them into typed failures', () => {
    const defect = new Error('unexpected runtime defect')
    const cause = Cause.die(defect)
    const { entries, exit } = capture(Effect.failCause(cause).pipe(operationFailureLogging))

    expect(exit).toEqual(Exit.failCause(cause))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.cause).toBe(cause)
  })

  it('does not hide a real failure when its cause also contains interruption', () => {
    const cause = Cause.combine(Cause.die(new Error('runtime defect')), Cause.interrupt(123))
    const { entries, exit } = capture(Effect.failCause(cause).pipe(operationFailureLogging))

    expect(exit).toEqual(Exit.failCause(cause))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.cause).toBe(cause)
  })
})
