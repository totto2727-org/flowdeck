import { Machine } from '@typeonce/effect-machine'
import { Context, Effect, Option, Schema } from 'effect'

import { makePiNodeEffects, PiNodeEffects, piNodeEvent } from '@/core/feature/pi/node'
import { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'
import { JsonObject } from '@/core/feature/workflow/domain/model'
import type { GraphDefinition, Run, RunStatus, WorkflowSummary } from '@/core/feature/workflow/domain/model'
import { projectMachineGraph } from '@/core/feature/workflow/graph'
import { ManagedSnapshot, makeManagedExecutor, restoreManagedSnapshot } from '@/core/feature/workflow/managed-runtime'
import type { EventDraft } from '@/core/feature/workflow/managed-runtime'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'

import { DevelopmentMachine, DevelopmentStates } from './development-machine.ts'
import type { DevelopmentNativeState } from './development-machine.ts'
import { developmentVersion } from './input.ts'
import type { DevelopmentCreateRun, DevelopmentWorkflowVersion } from './input.ts'

export { ManagedSnapshot as DevelopmentSnapshot } from '@/core/feature/workflow/managed-runtime'
export const DevelopmentSnapshotJson = Schema.toCodecJson(ManagedSnapshot)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The native machine encoder produces an unchecked wire object.
const decodeObject = Schema.decodeUnknownEffect(JsonObject)
const decodeNative = (encoded: JsonObject): Effect.Effect<DevelopmentNativeState, InvalidSnapshot> =>
  Machine.decodeSnapshot(DevelopmentMachine, encoded).pipe(
    Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid development native machine checkpoint' })),
  )
const encodeNative = (state: DevelopmentNativeState): Effect.Effect<JsonObject, InvalidSnapshot> =>
  Machine.encodeSnapshot(DevelopmentMachine, state).pipe(
    Effect.flatMap(decodeObject),
    Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid development native machine state' })),
  )

export const developmentGraph: GraphDefinition = projectMachineGraph({
  graphId: 'jcode-development-1_0_0-graph-1',
  nodes: Machine.stateNodes(DevelopmentMachine),
  transitions: Machine.transitionDefinitions(DevelopmentMachine),
})
export const developmentGraphFor = (_version: typeof DevelopmentWorkflowVersion.Type): GraphDefinition =>
  developmentGraph

export const developmentStatus = (state: DevelopmentNativeState): RunStatus => {
  if (DevelopmentStates.matches(state, 'completed')) {
    return 'completed'
  }
  if (DevelopmentStates.matches(state, 'failed')) {
    return 'failed'
  }
  if (DevelopmentStates.matches(state, 'implement.allocate')) {
    return 'pending'
  }
  if (DevelopmentStates.matches(state, 'implement.awaiting') || DevelopmentStates.matches(state, 'verify.awaiting')) {
    return 'waiting'
  }
  return 'running'
}
const terminalEvents = (state: DevelopmentNativeState): Readonly<EventDraft[]> => {
  const completed = DevelopmentStates.get(state, 'completed')
  if (Option.isSome(completed)) {
    return [
      piNodeEvent('verify', completed.value, 'node.succeeded', { output: completed.value.result }),
      { payload: {}, type: 'run.completed' },
    ]
  }
  const failed = DevelopmentStates.get(state, 'failed')
  if (Option.isSome(failed)) {
    return [
      piNodeEvent(failed.value.nodeId, failed.value, 'node.failed', { message: failed.value.message }),
      { payload: {}, type: 'run.failed' },
    ]
  }
  return []
}

const boundaryEvents = (state: DevelopmentNativeState): Readonly<EventDraft[]> => {
  const implementing = DevelopmentStates.get(state, 'implement.awaiting')
  if (Option.isSome(implementing)) {
    return [piNodeEvent('implement', implementing.value, 'run.waiting')]
  }
  const verifying = DevelopmentStates.get(state, 'verify.awaiting')
  if (Option.isSome(verifying)) {
    return [piNodeEvent('verify', verifying.value, 'run.waiting')]
  }
  return terminalEvents(state)
}

export const initialDevelopmentSnapshot = (input: DevelopmentCreateRun): Effect.Effect<ManagedSnapshot> =>
  Machine.planInitial(DevelopmentMachine, input).pipe(
    Effect.flatMap((initial) => encodeNative(initial.state)),
    Effect.map((machine): ManagedSnapshot => ({ machine, schemaVersion: 1, version: developmentVersion })),
    Effect.orDie,
  )
const restoration = {
  decode: decodeNative,
  graph: developmentGraph,
  status: developmentStatus,
  version: developmentVersion,
  workflowId: 'jcode-development',
}
export const restoreDevelopment = (run: Run): Effect.Effect<DevelopmentNativeState, WorkflowFailure> =>
  restoreManagedSnapshot(restoration, run)

/** Stable provider and Crypto dependencies are captured once. The managed host
 * owns the execution Scope and supplies one volatile ResourceStore per command. */
const program = Effect.gen(function* () {
  const pi = yield* makePiNodeEffects
  return {
    boundaryEvents,
    decode: decodeNative,
    encode: encodeNative,
    isReplyBoundary: (state: DevelopmentNativeState) => {
      const status = developmentStatus(state)
      return status === 'waiting' || status === 'completed' || status === 'failed'
    },
    mapError: () => new InvalidSnapshot({ message: 'Development machine execution failed' }),
    resume: (state: DevelopmentNativeState) =>
      Machine.resume(DevelopmentMachine, state).pipe(Effect.provideService(PiNodeEffects, pi)),
    start: (state: DevelopmentNativeState) =>
      Effect.gen(function* () {
        const input = Option.getOrThrow(DevelopmentStates.get(state, ''))
        return yield* Machine.start(DevelopmentMachine, {
          repository: input.repository,
          task: input.task,
          version: input.version,
          workflowId: 'jcode-development',
        }).pipe(Effect.provideService(PiNodeEffects, pi))
      }),
    status: developmentStatus,
  }
})
export const makeDevelopmentExecutor = makeManagedExecutor({
  graph: developmentGraph,
  program,
  version: developmentVersion,
  workflowId: 'jcode-development',
})
export class DevelopmentExecutor extends Context.Service<
  DevelopmentExecutor,
  Effect.Success<typeof makeDevelopmentExecutor>
>()('flowdeck/DevelopmentExecutor') {}
type DevelopmentRequirements = Effect.Services<typeof makeDevelopmentExecutor>

export const startDevelopmentRun = (runId: RunId): Effect.Effect<undefined, WorkflowFailure, DevelopmentRequirements> =>
  Effect.flatMap(makeDevelopmentExecutor, (executor) => executor.start(runId))
export const resumeDevelopmentRun = (
  runId: RunId,
): Effect.Effect<undefined, WorkflowFailure, DevelopmentRequirements> =>
  Effect.flatMap(makeDevelopmentExecutor, (executor) => executor.resume(runId))

export const developmentWorkflow: WorkflowSummary = {
  inputs: [
    {
      kind: 'text',
      label: 'Public GitHub repository',
      maxLength: 256,
      name: 'repository',
      placeholder: 'https://github.com/owner/repository',
      required: true,
    },
    {
      kind: 'textarea',
      label: 'Development task',
      maxLength: 16_000,
      name: 'task',
      placeholder: 'Describe the change to implement and verify.',
      required: true,
    },
  ],
  name: 'Pi development',
  versions: [developmentVersion],
  workflowId: 'jcode-development',
}
