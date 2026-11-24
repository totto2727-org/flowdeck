import { BrowserCrypto } from '@effect/platform-browser'
import { Context, Effect, Layer, Logger, References } from 'effect'
import type { Crypto, Exit, Scope } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/http'

import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { ApiRoutes } from '@/core/worker/control/feature/router'

type LoggedEntry = Logger.Options<unknown> & Readonly<{ annotations: Readonly<Record<string, unknown>> }>

export type CapturedOperation<A, E> = Readonly<{ entries: Readonly<LoggedEntry[]>; exit: Exit.Exit<A, E> }>

const recordLogs = Effect.sync(() => {
  const entries: LoggedEntry[] = []
  const logger = Logger.make((entry) => {
    entries.push({ ...entry, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { entries, logger }
})

const request = HttpServerRequest.fromWeb(new Request('http://localhost/'))

export const capture = <A, E>(
  operation: Effect.Effect<A, E, HttpServerRequest.HttpServerRequest | Crypto.Crypto>,
): Effect.Effect<CapturedOperation<A, E>> =>
  Effect.gen(function* () {
    const { entries, logger } = yield* recordLogs
    const exit = yield* operation.pipe(
      Effect.exit,
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provide(BrowserCrypto.layer),
      Effect.provide(Logger.layer([logger])),
    )
    return { entries, exit }
  })

export const getRuns = (
  listRuns: () => Effect.Effect<never, WorkflowFailure>,
): Effect.Effect<Readonly<{ entries: Readonly<LoggedEntry[]>; response: Response }>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const workflows = {
      createRun: listRuns,
      getRunDetail: listRuns,
      listRuns,
      listWorkflows: listRuns,
      resumeRun: listRuns,
    }
    const services = Layer.succeed(Workflows, workflows)
    const routes = ApiRoutes.pipe(HttpRouter.provideRequest(services))
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes)),
      (server) => Effect.promise(async () => server.dispose()),
    )
    const { entries, logger } = yield* recordLogs
    const logging = Context.make(Logger.CurrentLoggers, new Set([logger]))
    const response = yield* Effect.promise(async () =>
      handler.handler(new Request('http://localhost/api/runs'), logging),
    )
    return { entries, response }
  })

export const originalError = (message: string): Error =>
  // oxlint-disable-next-line rules/require-tagged-error -- Exercise native errors that appear below the logging boundary.
  new Error(message)

export const executeQueryFrame = 'at executeQuery (database.ts:42:7)'

export const errorWithFrame = (message: string, frame: string): Error => {
  const original = originalError(message)
  original.stack = `Error: ${message}\n    ${frame}`
  return original
}

export const databaseError = (): Error => errorWithFrame('D1 execution failed', executeQueryFrame)
