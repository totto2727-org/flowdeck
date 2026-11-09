import { Context, Effect, Match, Schema, SemVer } from 'effect'

import { InvalidSnapshot } from '@/features/workflow/domain/errors'
import type { RunId } from '@/features/workflow/domain/identity'
import { type GraphDefinition, type Run, type WorkflowSummary } from '@/features/workflow/domain/model'
import {
  encodeMachineSnapshot,
  initialMachineSnapshot,
  MachineSnapshot,
  makeDriver,
  restoreMachineSnapshot,
} from '@/features/workflow/driver'
import { Store } from '@/features/workflow/services/store'

import { DemoWorkflowVersion, demoVersion1, demoVersion2 } from './input'
import { initialDemoContext } from './node'
import { demoVersion1Definition } from './version-1'
import { demoVersion2Definition } from './version-2'

export const DemoSnapshot = MachineSnapshot
export type DemoSnapshot = typeof DemoSnapshot.Type
const decodeVersion = Schema.decodeUnknownEffect(DemoWorkflowVersion)
export const encodeDemoSnapshot = (snapshot: DemoSnapshot) => Effect.succeed(encodeMachineSnapshot(snapshot))
export const demoWorkflow: WorkflowSummary = {
  workflowId: 'demo',
  name: 'Release checkpoint',
  versions: [demoVersion1, demoVersion2],
  inputs: [],
}
const demoImplementation = (version: DemoWorkflowVersion) =>
  Match.value(version).pipe(
    Match.when(
      (selected) => SemVer.equals(selected, demoVersion1),
      () => demoVersion1Definition,
    ),
    Match.when(
      (selected) => SemVer.equals(selected, demoVersion2),
      () => demoVersion2Definition,
    ),
    Match.orElseAbsurd,
  )
export const demoGraph = (version: DemoWorkflowVersion): GraphDefinition => demoImplementation(version).machine.graph
export const initialSnapshot = (version: DemoWorkflowVersion): DemoSnapshot =>
  initialMachineSnapshot(demoImplementation(version), initialDemoContext)
export const restoreDemo = (run: Run) =>
  decodeVersion(run.workflowVersion).pipe(
    Effect.mapError(() => new InvalidSnapshot({ message: 'Unsupported demo version' })),
    Effect.flatMap((version) => restoreMachineSnapshot(demoImplementation(version), run)),
  )
export const makeDemoExecutor = Effect.gen(function* () {
  const v1 = yield* makeDriver(demoVersion1Definition)
  const v2 = yield* makeDriver(demoVersion2Definition)
  // Both complete service graphs are captured here, not provided per task.
  const store = yield* Store
  const drive = (runId: RunId, operation: 'start' | 'resume') =>
    Effect.gen(function* () {
      const run = yield* store.getRun(runId)
      yield* restoreDemo(run)
      const definition = demoImplementation(run.workflowVersion)
      const executor = SemVer.equals(definition.version, demoVersion1) ? v1 : v2
      yield* executor[operation](runId)
    })
  return { start: (runId: RunId) => drive(runId, 'start'), resume: (runId: RunId) => drive(runId, 'resume') }
})
export class DemoExecutor extends Context.Service<DemoExecutor, Effect.Success<typeof makeDemoExecutor>>()(
  'flowdeck/DemoExecutor',
) {}
export const startRun = (runId: RunId) => Effect.flatMap(makeDemoExecutor, (executor) => executor.start(runId))
export const resumeRun = (runId: RunId) => Effect.flatMap(makeDemoExecutor, (executor) => executor.resume(runId))
