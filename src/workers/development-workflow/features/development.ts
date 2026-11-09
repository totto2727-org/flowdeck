import { Context, Effect, Schema } from 'effect'

import type { RunId } from '@/features/workflow/domain/identity'
import type { GraphDefinition, Run, WorkflowSummary } from '@/features/workflow/domain/model'
import {
  initialMachineSnapshot,
  MachineSnapshot,
  makeDefinition,
  makeDriver,
  restoreMachineSnapshot,
} from '@/features/workflow/driver'
import { makeMachine } from '@/features/workflow/machine'

import { DevelopmentMachine } from './development-machine'
import { developmentVersion, type DevelopmentCreateRun, type DevelopmentWorkflowVersion } from './input'
import { DevelopmentContext, makePiTasks, PiPhase } from './pi-task'

const machine = makeMachine({ graphId: 'jcode-development-1_0_0-graph-1', native: DevelopmentMachine })
const executionDefinition = makeDefinition({
  workflowId: 'jcode-development',
  version: developmentVersion,
  machine,
  context: DevelopmentContext,
  tasks: makePiTasks,
})
export const DevelopmentSnapshot = MachineSnapshot
export type DevelopmentSnapshot = typeof DevelopmentSnapshot.Type
export const DevelopmentSnapshotJson = Schema.toCodecJson(DevelopmentSnapshot)

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
export const developmentGraph: GraphDefinition = machine.graph
export const developmentGraphFor = (_version: typeof DevelopmentWorkflowVersion.Type): GraphDefinition =>
  developmentGraph
export const initialDevelopmentSnapshot = (input: DevelopmentCreateRun): DevelopmentSnapshot =>
  initialMachineSnapshot(executionDefinition, {
    version: input.version,
    runtime: 'pi-harness',
    repository: input.repository,
    task: input.task,
    phase: PiPhase.cases.Ready.make({}),
  })

/** Restore validates both the common execution envelope and the Pi-owned recovery context before any sandbox access. */
export const restoreDevelopment = (run: Run) => restoreMachineSnapshot(executionDefinition, run)

/** The Worker root constructs this service once with the complete Store, Hooks, Crypto and Pi sandbox Layer graph. */
export const makeDevelopmentExecutor = makeDriver(executionDefinition)
export class DevelopmentExecutor extends Context.Service<
  DevelopmentExecutor,
  Effect.Success<typeof makeDevelopmentExecutor>
>()('flowdeck/DevelopmentExecutor') {}
export const startDevelopmentRun = (runId: RunId) =>
  Effect.flatMap(makeDevelopmentExecutor, (executor) => executor.start(runId))
export const resumeDevelopmentRun = (runId: RunId) =>
  Effect.flatMap(makeDevelopmentExecutor, (executor) => executor.resume(runId))
