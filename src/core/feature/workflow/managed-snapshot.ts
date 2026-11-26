import { Effect, Result, Schema, SemVer } from 'effect'

import { ExternalError, InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { JsonObject, WorkflowVersion } from '@/core/feature/workflow/domain/model'
import type { GraphDefinition, Run, RunStatus } from '@/core/feature/workflow/domain/model'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'

const snapshotSchemaVersion = 1
// oxlint-disable-next-line eslint/no-redeclare -- Keep the schema and type exports and preserve the encoded property order of stored snapshots.
export const ManagedSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(snapshotSchemaVersion),
  version: WorkflowVersion,
  machine: JsonObject,
})
export type ManagedSnapshot = typeof ManagedSnapshot.Type
const snapshotCodec = Schema.toCodecJson(ManagedSnapshot)
const decodeSnapshot = Schema.decodeEffect(snapshotCodec)
const encodeSnapshot = Schema.encodeResult(snapshotCodec)
const decodeObject = Schema.decodeUnknownResult(JsonObject)
export const equivalentSnapshot = Schema.toEquivalence(JsonObject)

export const encodeManagedSnapshot = (snapshot: ManagedSnapshot): JsonObject => {
  const encoded = Result.getOrThrow(encodeSnapshot(snapshot))
  return Result.getOrThrow(decodeObject(encoded))
}

/** Codec validation requires no Store, provider runtime, or Crypto dependencies. */
export type ManagedRestoration<State> = Readonly<{
  workflowId: string
  version: WorkflowVersion
  graph: GraphDefinition
  decode: (encoded: JsonObject) => Effect.Effect<State, WorkflowFailure>
  status: (state: State) => RunStatus
}>

export const restoreManagedSnapshot = <State>(
  definition: ManagedRestoration<State>,
  run: Run,
): Effect.Effect<State, WorkflowFailure> =>
  Effect.gen(function* () {
    const snapshot = yield* decodeSnapshot(run.snapshot).pipe(
      Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid managed machine snapshot' })),
    )
    if (
      run.workflowId !== definition.workflowId ||
      !SemVer.equals(run.workflowVersion, definition.version) ||
      !SemVer.equals(snapshot.version, definition.version) ||
      run.graphId !== definition.graph.graphId
    ) {
      return yield* Effect.fail(new InvalidSnapshot({ message: 'Run identity, version and graph must agree' }))
    }
    const state = yield* definition.decode(snapshot.machine)
    if (definition.status(state) !== run.status) {
      return yield* Effect.fail(new InvalidSnapshot({ message: 'Native state and run status must agree' }))
    }
    return state
  }).pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(
        new ExternalError({
          cause,
          kind: 'service',
          operation: 'restore native machine',
        }),
      ),
    ),
  )
