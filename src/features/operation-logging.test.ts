import { encodeRpcError, makeRpcErrorReviver } from 'alchemy/Rpc'
import { Cause, Context, Effect, Exit, Layer, Logger } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect, it } from 'vite-plus/test'

import { ApiRoutes } from '../workers/control/features/router'
import { operationFailureLogging } from './operation-logging'
import { Conflict, ExternalError } from './workflow/domain/errors'
import { workflowRpcErrors } from './workflow/services/workflow-rpc'
import { Workflows } from './workflow/services/workflows'

const capture = <A, E>(effect: Effect.Effect<A, E, HttpServerRequest.HttpServerRequest>) => {
  const entries: Array<Logger.Options<unknown>> = []
  const logger = Logger.make((entry) => entries.push(entry))
  const exit = Effect.runSyncExit(
    effect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request('http://localhost/')),
      ),
      Effect.provide(Logger.layer([logger])),
    ),
  )
  return { entries, exit }
}

describe('operation failure logging', () => {
  it.each(['storage', 'conflict'] as const)(
    'preserves the original stack through official RPC %s error revival',
    (kind) => {
      const original = new Error('D1 execution failed')
      original.stack = 'Error: D1 execution failed\n    at executeQuery (database.ts:42:7)'
      const error =
        kind === 'storage'
          ? new ExternalError({ operation: 'persist run', kind: 'storage', cause: original })
          : new Conflict({ message: 'flowdeck_conflict', cause: original })
      const revived = makeRpcErrorReviver(workflowRpcErrors)(structuredClone(encodeRpcError(error)))
      const { entries } = capture(Effect.fail(revived).pipe(operationFailureLogging))
      expect(entries).toHaveLength(1)
      expect(Cause.pretty(entries[0]!.cause)).toContain('at executeQuery (database.ts:42:7)')
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
