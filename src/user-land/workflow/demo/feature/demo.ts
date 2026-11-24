import { Context, Effect, Match, Schema, SemVer } from 'effect'

import { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'
import type { GraphDefinition, Run, WorkflowSummary } from '@/core/feature/workflow/domain/model'
import { encodeManagedSnapshot, ManagedSnapshot, makeManagedExecutor } from '@/core/feature/workflow/managed-runtime'
import { Store } from '@/core/feature/workflow/services/store'

import { DemoWorkflowVersion, demoVersion1, demoVersion2 } from './input.ts'
import { demoStatus } from './node.ts'
import { decodeDemoVersion1, demoVersion1Definition, initialDemoVersion1 } from './version-1.ts'
import { decodeDemoVersion2, demoVersion2Definition, initialDemoVersion2 } from './version-2.ts'

export { ManagedSnapshot as DemoSnapshot } from '@/core/feature/workflow/managed-runtime'
const decodeVersion = Schema.decodeUnknownEffect(DemoWorkflowVersion)
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.toCodecJson(ManagedSnapshot))
export const encodeDemoSnapshot = (snapshot: ManagedSnapshot) => Effect.succeed(encodeManagedSnapshot(snapshot))
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
export const demoGraph = (version: DemoWorkflowVersion): GraphDefinition => demoImplementation(version).graph
export const initialSnapshot = (version: DemoWorkflowVersion): Effect.Effect<ManagedSnapshot> =>
  Effect.map(SemVer.equals(version, demoVersion1) ? initialDemoVersion1 : initialDemoVersion2, (machine) => ({
    schemaVersion: 1,
    version,
    machine,
  }))

/** Decode-only validation never opens a native runtime or acquires Crypto. */
export const restoreDemo = (run: Run) =>
  Effect.gen(function* () {
    const version = yield* decodeVersion(run.workflowVersion).pipe(
      Effect.mapError(() => new InvalidSnapshot({ message: 'Unsupported demo version' })),
    )
    const snapshot = yield* decodeSnapshot(run.snapshot).pipe(
      Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid managed demo snapshot' })),
    )
    const definition = demoImplementation(version)
    if (
      run.workflowId !== 'demo' ||
      !SemVer.equals(snapshot.version, version) ||
      run.graphId !== definition.graph.graphId
    ) {
      return yield* Effect.fail(new InvalidSnapshot({ message: 'Demo identity, graph and version must agree' }))
    }
    const state = yield* SemVer.equals(version, demoVersion1)
      ? decodeDemoVersion1(snapshot.machine)
      : decodeDemoVersion2(snapshot.machine)
    if (demoStatus(state) !== run.status) {
      return yield* Effect.fail(new InvalidSnapshot({ message: 'Native demo state and run status must agree' }))
    }
    return snapshot
  })
export const makeDemoExecutor = Effect.gen(function* () {
  const v1 = yield* makeManagedExecutor(demoVersion1Definition)
  const v2 = yield* makeManagedExecutor(demoVersion2Definition)
  const store = yield* Store
  const drive = (runId: RunId, operation: 'start' | 'resume') =>
    Effect.gen(function* () {
      const run = yield* store.getRun(runId)
      yield* restoreDemo(run)
      const executor = SemVer.equals(run.workflowVersion, demoVersion1) ? v1 : v2
      yield* executor[operation](runId)
    })
  return { start: (runId: RunId) => drive(runId, 'start'), resume: (runId: RunId) => drive(runId, 'resume') }
})
export class DemoExecutor extends Context.Service<DemoExecutor, Effect.Success<typeof makeDemoExecutor>>()(
  'flowdeck/DemoExecutor',
) {}
export const startRun = (runId: RunId) => Effect.flatMap(makeDemoExecutor, (executor) => executor.start(runId))
export const resumeRun = (runId: RunId) => Effect.flatMap(makeDemoExecutor, (executor) => executor.resume(runId))
