import { Machine } from '@typeonce/effect-machine'
import { Context, Effect, Option, Schema } from 'effect'

import { makePiNodeEffects, PiNodeEffects, piNodeEvent } from '@/core/feature/pi/node'
import { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'
import {
  JsonObject,
  type GraphDefinition,
  type Run,
  type RunStatus,
  type WorkflowSummary,
} from '@/core/feature/workflow/domain/model'
import { projectMachineGraph } from '@/core/feature/workflow/graph'
import {
  ManagedSnapshot,
  makeManagedExecutor,
  restoreManagedSnapshot,
  type EventDraft,
} from '@/core/feature/workflow/managed-runtime'

import { DevelopmentMachine, DevelopmentStates, type DevelopmentNativeState } from './development-machine'
import { developmentVersion, type DevelopmentCreateRun, type DevelopmentWorkflowVersion } from './input'

export const DevelopmentSnapshot = ManagedSnapshot
export type DevelopmentSnapshot = typeof DevelopmentSnapshot.Type
export const DevelopmentSnapshotJson = Schema.toCodecJson(DevelopmentSnapshot)
const decodeObject = Schema.decodeUnknownSync(JsonObject)
const decodeNative = (encoded: JsonObject) =>
  Machine.decodeSnapshot(DevelopmentMachine, encoded).pipe(
    Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid development native machine checkpoint' })),
  )
const encodeNative = (state: DevelopmentNativeState) =>
  Machine.encodeSnapshot(DevelopmentMachine, state).pipe(
    Effect.map(decodeObject),
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
  if (DevelopmentStates.matches(state, 'completed')) return 'completed'
  if (DevelopmentStates.matches(state, 'failed')) return 'failed'
  if (DevelopmentStates.matches(state, 'implement.allocate')) return 'pending'
  if (DevelopmentStates.matches(state, 'implement.awaiting') || DevelopmentStates.matches(state, 'verify.awaiting'))
    return 'waiting'
  return 'running'
}
const boundaryEvents = (state: DevelopmentNativeState): ReadonlyArray<EventDraft> => {
  const implementing = DevelopmentStates.get(state, 'implement.awaiting')
  if (Option.isSome(implementing)) return [piNodeEvent('implement', implementing.value, 'run.waiting')]
  const verifying = DevelopmentStates.get(state, 'verify.awaiting')
  if (Option.isSome(verifying)) return [piNodeEvent('verify', verifying.value, 'run.waiting')]
  const completed = DevelopmentStates.get(state, 'completed')
  if (Option.isSome(completed))
    return [
      piNodeEvent('verify', completed.value, 'node.succeeded', { output: completed.value.result }),
      { type: 'run.completed', payload: {} },
    ]
  const failed = DevelopmentStates.get(state, 'failed')
  if (Option.isSome(failed))
    return [
      piNodeEvent(failed.value.nodeId, failed.value, 'node.failed', { message: failed.value.message }),
      { type: 'run.failed', payload: {} },
    ]
  return []
}

export const initialDevelopmentSnapshot = (input: DevelopmentCreateRun): DevelopmentSnapshot => {
  const initial = Effect.runSync(Machine.planInitial(DevelopmentMachine, input))
  return { schemaVersion: 1, version: developmentVersion, machine: Effect.runSync(encodeNative(initial.state)) }
}
const restoration = {
  workflowId: 'jcode-development',
  version: developmentVersion,
  graph: developmentGraph,
  decode: decodeNative,
  status: developmentStatus,
}
export const restoreDevelopment = (run: Run) => restoreManagedSnapshot(restoration, run)

/** Stable provider and Crypto dependencies are captured once. The managed host
 * owns the execution Scope and supplies one volatile ResourceStore per command. */
const program = Effect.gen(function* () {
  const pi = yield* makePiNodeEffects
  return {
    decode: decodeNative,
    encode: encodeNative,
    start: (state: DevelopmentNativeState) =>
      Effect.gen(function* () {
        const input = Option.getOrThrow(DevelopmentStates.get(state, ''))
        return yield* Machine.start(DevelopmentMachine, {
          workflowId: 'jcode-development',
          version: input.version,
          repository: input.repository,
          task: input.task,
        }).pipe(Effect.provideService(PiNodeEffects, pi))
      }),
    resume: (state: DevelopmentNativeState) =>
      Machine.resume(DevelopmentMachine, state).pipe(Effect.provideService(PiNodeEffects, pi)),
    isReplyBoundary: (state: DevelopmentNativeState) => {
      const status = developmentStatus(state)
      return status === 'waiting' || status === 'completed' || status === 'failed'
    },
    status: developmentStatus,
    boundaryEvents,
    mapError: () => new InvalidSnapshot({ message: 'Development machine execution failed' }),
  }
})
export const makeDevelopmentExecutor = makeManagedExecutor({
  workflowId: 'jcode-development',
  version: developmentVersion,
  graph: developmentGraph,
  program,
})
export class DevelopmentExecutor extends Context.Service<
  DevelopmentExecutor,
  Effect.Success<typeof makeDevelopmentExecutor>
>()('flowdeck/DevelopmentExecutor') {}
export const startDevelopmentRun = (runId: RunId) =>
  Effect.flatMap(makeDevelopmentExecutor, (executor) => executor.start(runId))
export const resumeDevelopmentRun = (runId: RunId) =>
  Effect.flatMap(makeDevelopmentExecutor, (executor) => executor.resume(runId))

export const developmentWorkflow: WorkflowSummary = {
  workflowId: 'jcode-development',
  name: 'Pi development',
  versions: [developmentVersion],
  inputs: [
    {
      name: 'repository',
      label: 'Public GitHub repository',
      kind: 'text',
      required: true,
      placeholder: 'https://github.com/owner/repository',
      maxLength: 256,
    },
    {
      name: 'task',
      label: 'Development task',
      kind: 'textarea',
      required: true,
      placeholder: 'Describe the change to implement and verify.',
      maxLength: 16_000,
    },
  ],
}
