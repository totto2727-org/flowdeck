import { BrowserCrypto } from '@effect/platform-browser'
import { Machine } from '@typeonce/effect-machine'
import { Array, Data, Effect, Layer, Option, Ref } from 'effect'

import { resumeEvent, WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'
import type { EventDraft } from '@/core/feature/workflow/managed-runtime'

import { demoBoundaryEvents } from './node.ts'
import type { DemoData } from './node.ts'
import { demoVersion1Machine, demoVersion1States } from './version-1.ts'
import { demoVersion2Machine, demoVersion2States } from './version-2.ts'

export const implementations = [
  { draft: 'draft:v1', native: demoVersion1Machine, states: demoVersion1States },
  { draft: 'draft:v2:reviewed', native: demoVersion2Machine, states: demoVersion2States },
]
type Implementation = (typeof implementations)[number]
type NativeMachine = Implementation['native']

const executionIds = {
  approval: 'execution_00000000-0000-4000-8000-000000000002',
  prepare: 'execution_00000000-0000-4000-8000-000000000001',
  publish: 'execution_00000000-0000-4000-8000-000000000003',
}
const runId = 'run_00000000-0000-4000-8000-000000000001'

export const recordedCheckpoints = Effect.gen(function* () {
  const recorded = yield* Ref.make<EventDraft[]>([])
  const checkpoint = Layer.succeed(WorkflowCheckpoint, {
    checkpoint: (events) => Ref.update(recorded, (history) => Array.appendAll(history, events)),
    fail: Effect.die,
    runId,
  })
  return { events: Ref.get(recorded), services: Layer.merge(checkpoint, BrowserCrypto.layer) }
})

type WireNativeNode = Data.TaggedEnum<{
  prepare: { prepareExecutionId: string }
  publish: {
    approvalExecutionId: string
    prepareExecutionId: string
    prepared: string
    publishExecutionId: string
  }
}>
const wireNode = Data.taggedEnum<WireNativeNode>()
const machineWireVersion = 2
const snapshot = Data.taggedEnum<
  Data.TaggedEnum<{
    MachineSnapshot: {
      active: Readonly<{ path: string; value?: WireNativeNode }>[]
      version: typeof machineWireVersion
    }
  }>
>().MachineSnapshot

export const restoredInvokes = Array.flatMap(
  implementations,
  (implementation) =>
    [
      {
        ...implementation,
        executionId: executionIds.prepare,
        expected: { prepareExecutionId: executionIds.prepare },
        next: 'approval',
        phase: 'prepare',
        value: wireNode.prepare({ prepareExecutionId: executionIds.prepare }),
      },
      {
        ...implementation,
        executionId: executionIds.publish,
        expected: {
          approvalExecutionId: executionIds.approval,
          prepareExecutionId: executionIds.prepare,
          publishExecutionId: executionIds.publish,
          result: `published:${implementation.draft}`,
        },
        next: 'completed',
        phase: 'publish',
        value: wireNode.publish({
          approvalExecutionId: executionIds.approval,
          prepareExecutionId: executionIds.prepare,
          prepared: implementation.draft,
          publishExecutionId: executionIds.publish,
        }),
      },
    ] as const,
)

type RestoredInvoke = (typeof restoredInvokes)[number]

export const resumeCommittedInvoke = Effect.fn('flowdeck.test.resumeCommittedDemoInvoke')(function* ({
  native,
  next,
  phase,
  states,
  value,
}: RestoredInvoke) {
  const record = yield* recordedCheckpoints
  const result = yield* Effect.gen(function* () {
    const wire = snapshot({ active: [{ path: '' }, { path: phase, value }], version: machineWireVersion })
    const restored = yield* Machine.decodeSnapshot(native, wire)
    const ref = yield* Machine.resume(native, restored)
    const boundary = yield* Machine.waitFor(ref, ({ state }) => states.matches(state, next))
    return Option.getOrThrow(states.get(boundary.state, next))
  }).pipe(Effect.scoped, Effect.provide(record.services))
  return { events: yield* record.events, result }
})

export const startUntilApproval = Effect.fn('flowdeck.test.startDemoUntilApproval')(function* ({
  native,
  states,
}: Implementation) {
  const ref = yield* Machine.start(native)
  const boundary = yield* Machine.waitFor(ref, ({ state }) => states.matches(state, 'approval'))
  const data = Option.getOrThrow(states.get(boundary.state, 'approval'))
  const encoded = yield* Machine.encodeSnapshot(native, boundary.state)
  return { boundary: demoBoundaryEvents(boundary.state), data, encoded }
})

type Waiting = Effect.Success<ReturnType<typeof startUntilApproval>>
type ApprovalData = typeof DemoData.cases.approval.Type

const fromCheckpoint = Effect.fn('flowdeck.test.openRestoredDemoCheckpoint')(function* (
  native: NativeMachine,
  encoded: Waiting['encoded'],
) {
  const state = yield* Machine.decodeSnapshot(native, encoded)
  return yield* Machine.resume(native, state)
})

export const restoreThroughCompletion = Effect.fn('flowdeck.test.restoreDemoThroughCompletion')(function* (
  { native, states }: Implementation,
  waiting: Waiting,
  record: Effect.Success<typeof recordedCheckpoints>,
) {
  const restored = yield* fromCheckpoint(native, waiting.encoded)
  const atApproval = states.matches(yield* restored.state, 'approval')
  const beforeResume = yield* record.events
  yield* restored.send(resumeEvent)
  const completed = yield* Machine.waitFor(restored, ({ state }) => states.matches(state, 'completed'))
  const result = Option.getOrThrow(states.get(completed.state, 'completed'))
  return { atApproval, beforeResume, final: demoBoundaryEvents(completed.state), result }
})

export const firstCheckpoints = ({ prepareExecutionId }: ApprovalData): EventDraft[] => [
  { payload: {}, type: 'run.started' },
  { attempt: 1, executionId: prepareExecutionId, nodeId: 'prepare', payload: {}, type: 'node.started' },
]

export const approvalCheckpoints = ({
  approvalExecutionId,
  prepareExecutionId,
  prepared,
}: ApprovalData): EventDraft[] => [
  {
    attempt: 1,
    executionId: prepareExecutionId,
    nodeId: 'prepare',
    payload: { output: prepared },
    type: 'node.succeeded',
  },
  { attempt: 1, executionId: approvalExecutionId, nodeId: 'approval', payload: {}, type: 'node.started' },
  { attempt: 1, executionId: approvalExecutionId, nodeId: 'approval', payload: {}, type: 'run.waiting' },
]

type PublishData = typeof DemoData.cases.completed.Type
export const resumedCheckpoints = (data: ApprovalData, { publishExecutionId }: PublishData): EventDraft[] => [
  ...firstCheckpoints(data),
  {
    attempt: 1,
    executionId: data.approvalExecutionId,
    nodeId: 'approval',
    payload: { approved: true },
    type: 'node.succeeded',
  },
  { attempt: 1, executionId: publishExecutionId, nodeId: 'publish', payload: {}, type: 'node.started' },
]

export const completionCheckpoints = ({ publishExecutionId, result }: PublishData): EventDraft[] => [
  {
    attempt: 1,
    executionId: publishExecutionId,
    nodeId: 'publish',
    payload: { output: result },
    type: 'node.succeeded',
  },
  { payload: {}, type: 'run.completed' },
]
