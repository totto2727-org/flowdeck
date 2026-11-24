import { BrowserCrypto } from '@effect/platform-browser'
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Schema } from 'effect'
import { Cause, Effect, Logger, Option, Predicate, References } from 'effect'

import { ExternalError, NotFound } from '@/core/feature/workflow/domain/errors'
import { rpcResponse, rpcResult } from '@/core/feature/workflow/rpc/boundary'
import { RemoteWorkerError } from '@/core/feature/workflow/rpc/problem'

type Scenario = 'success' | 'failure' | 'not-found' | 'defect'
interface ChildBinding {
  start(scenario: Scenario): Promise<string>
}

const entries: Schema.Json[] = []
const logger = Logger.make((entry) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(entry.cause))
  const annotations = entry.fiber.getRef(References.CurrentLogAnnotations)
  entries.push({
    operation: String(annotations['operation']),
    errorId: String(annotations['errorId']),
    renderedCause: Cause.pretty(entry.cause),
    localStack: Predicate.isError(error) ? (error.stack ?? '') : '',
    originalStack: error instanceof ExternalError && Predicate.isError(error.cause) ? (error.cause.stack ?? '') : '',
    remoteError: error instanceof RemoteWorkerError,
    externalError: error instanceof ExternalError,
    priorProblem: error instanceof RemoteWorkerError ? error.cause : null,
  })
})

const respond = <E>(operation: string, effect: Effect.Effect<Schema.Json, E>): Promise<string> =>
  // oxlint-disable-next-line rules/no-effect-runtime-run -- WorkerEntrypoint requires a native Promise and serializes the typed RPC outcome as JSON text.
  Effect.runPromise(
    effect.pipe(rpcResponse(operation), Effect.provide(BrowserCrypto.layer), Effect.provide(Logger.layer([logger]))),
  )

const originalError = (): Error => {
  const error = new Error('PRIVATE_RPC_DATABASE_PASSWORD')
  error.stack = 'Error: PRIVATE_RPC_DATABASE_PASSWORD\n    at childOnlyPrivateFrame (private-storage.ts:91:7)'
  error.cause = { cycle: error, nonJsonValue: BigInt(123) }
  return error
}

export class Child extends WorkerEntrypoint {
  start(scenario: Scenario): Promise<string> {
    if (scenario === 'success') {
      return respond('child.start', Effect.succeed({ answer: 42, values: [null, true, 'ok'] }))
    }
    const original = originalError()
    if (scenario === 'not-found') {
      const error = new NotFound({ resource: 'PRIVATE_RPC_DATABASE_PASSWORD' })
      error.stack = original.stack ?? ''
      return respond('child.start', Effect.fail(error))
    }
    return respond(
      'child.start',
      scenario === 'defect'
        ? Effect.die(original)
        : Effect.fail(new ExternalError({ operation: 'private SQL query', kind: 'storage', cause: original })),
    )
  }

  logs(): string {
    return JSON.stringify(entries)
  }
}

export default class Parent extends WorkerEntrypoint<{ CHILD: ChildBinding }> {
  start(scenario: Scenario): Promise<string> {
    return respond(
      'parent.start',
      Effect.tryPromise({
        catch: (cause) => new ExternalError({ operation: 'child transport', kind: 'service', cause }),
        try: () => this.env.CHILD.start(scenario),
      }).pipe(Effect.flatMap(rpcResult('child.start'))),
    )
  }

  logs(): string {
    return JSON.stringify(entries)
  }
}
