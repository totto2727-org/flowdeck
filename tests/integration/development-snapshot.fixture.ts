import { Machine } from '@typeonce/effect-machine'
import { DateTime, Effect, Option, Schema } from 'effect'

import type { TurnRequest } from '@/core/feature/pi/model'
import type { ExecutionId } from '@/core/feature/workflow/domain/identity'
import { JsonObject } from '@/core/feature/workflow/domain/model'
import type { Run } from '@/core/feature/workflow/domain/model'
import {
  DevelopmentSnapshotJson,
  developmentGraph,
  initialDevelopmentSnapshot,
} from '@/user-land/workflow/development/feature/development'
import { DevelopmentMachine, DevelopmentStates } from '@/user-land/workflow/development/feature/development-machine'
import { developmentVersion } from '@/user-land/workflow/development/feature/input'

export const developmentInput = {
  repository: new URL('https://github.com/example/project'),
  task: 'Add a greeting and test it.',
  version: developmentVersion,
  workflowId: 'jcode-development',
} as const
export const developmentTime = DateTime.makeUnsafe('2026-10-17T12:00:00.000Z')
export const decodeSnapshot = Schema.decodeEffect(DevelopmentSnapshotJson)

const encodeSnapshot = Schema.encodeEffect(DevelopmentSnapshotJson)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The native encoder returns generic JSON and the test persists only objects.
const decodeObject = Schema.decodeUnknownEffect(JsonObject)

export const makeInitialRun: Effect.Effect<Run, Schema.SchemaError> = Effect.gen(function* () {
  const checkpoint = yield* initialDevelopmentSnapshot(developmentInput)
  const wire = yield* encodeSnapshot(checkpoint)
  const snapshot = yield* decodeObject(wire)
  return {
    createdAt: developmentTime,
    graphId: developmentGraph.graphId,
    revision: 0,
    runId: 'run_00000000-0000-4000-8000-000000000002',
    snapshot,
    status: 'pending',
    updatedAt: developmentTime,
    workflowId: developmentInput.workflowId,
    workflowVersion: developmentVersion,
  }
})

export const nativeSnapshot = Effect.fn('flowdeck.test.readDevelopmentSnapshot')(function* (snapshot: Run['snapshot']) {
  const decoded = yield* decodeSnapshot(snapshot)
  const native = yield* Machine.decodeSnapshot(DevelopmentMachine, decoded.machine)
  return native
})

type NativeSnapshot = Effect.Success<ReturnType<typeof nativeSnapshot>>
type ActiveOperation = Readonly<{ commandId: TurnRequest['commandId']; executionId: ExecutionId }>
// oxlint-disable-next-line eslint/no-magic-numbers -- The second parameter provides the machine-checked state path type.
type StatePath = Parameters<typeof DevelopmentStates.matches>[1]

export const activeOperation = (native: NativeSnapshot): ActiveOperation =>
  Option.getOrThrow(
    Option.firstSomeOf([
      DevelopmentStates.get(native, 'implement.intent'),
      DevelopmentStates.get(native, 'implement.awaiting'),
      DevelopmentStates.get(native, 'verify.intent'),
      DevelopmentStates.get(native, 'verify.awaiting'),
    ]),
  )

export const activeOf = Effect.fn('flowdeck.test.currentDevelopmentOperation')(function* (snapshot: Run['snapshot']) {
  const native = yield* nativeSnapshot(snapshot)
  return activeOperation(native)
})

export const matches = Effect.fn('flowdeck.test.matchesDevelopmentState')(function* (
  snapshot: Run['snapshot'],
  path: StatePath,
) {
  const native = yield* nativeSnapshot(snapshot)
  return DevelopmentStates.matches(native, path)
})

export const rootOf = Effect.fn('flowdeck.test.developmentRootState')(function* (snapshot: Run['snapshot']) {
  const native = yield* nativeSnapshot(snapshot)
  return Option.getOrThrow(DevelopmentStates.get(native, ''))
})

export const failedOf = Effect.fn('flowdeck.test.developmentFailure')(function* (snapshot: Run['snapshot']) {
  const native = yield* nativeSnapshot(snapshot)
  return Option.getOrThrow(DevelopmentStates.get(native, 'failed'))
})
