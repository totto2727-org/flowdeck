import { BrowserCrypto } from '@effect/platform-browser'
import { Cause, Effect, Layer, Logger, Option, Predicate, References } from 'effect'
import type { Schema } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { rpcResponse } from '@/core/feature/workflow/rpc/boundary'
import { RemoteWorkerError } from '@/core/feature/workflow/rpc/problem'

export type Scenario = 'success' | 'failure' | 'not-found' | 'defect'
export type ChildBinding = Readonly<{ start: (scenario: Scenario) => Promise<string> }>

// oxlint-disable-next-line unicorn/no-null -- Native workerd RPC serializes absent problem details and the null reply fixture as JSON null.
export const absentJson = null

const entries: Schema.Json[] = []
const logger = Logger.make((entry) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(entry.cause))
  const annotations = entry.fiber.getRef(References.CurrentLogAnnotations)
  entries.push({
    errorId: String(annotations['errorId']),
    externalError: error instanceof ExternalError,
    localStack: Predicate.isError(error) ? (error.stack ?? '') : '',
    operation: String(annotations['operation']),
    originalStack: error instanceof ExternalError && Predicate.isError(error.cause) ? (error.cause.stack ?? '') : '',
    priorProblem: error instanceof RemoteWorkerError ? error.cause : absentJson,
    remoteError: error instanceof RemoteWorkerError,
    renderedCause: Cause.pretty(entry.cause),
  })
})

export const loggedEntries = (): string => JSON.stringify(entries)

const nativeServices = Layer.mergeAll(BrowserCrypto.layer, Logger.layer([logger]))

export const respond = async <E>(operation: string, effect: Effect.Effect<Schema.Json, E>): Promise<string> => {
  const encoded = effect.pipe(rpcResponse(operation), Effect.provide(nativeServices))
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Workerd invokes the entrypoint through a native Promise.
  return Effect.runPromise(encoded)
}
