import { Machine } from '@typeonce/effect-machine'
import { Effect, Option, Schema } from 'effect'

import { ExternalError, InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { ExecutionId } from '@/core/feature/workflow/domain/identity'
import type { RunStatus } from '@/core/feature/workflow/domain/model'
import { WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'
import type { EventDraft } from '@/core/feature/workflow/managed-runtime'

// Native approval and publish codecs use this field order in persisted snapshots.
const prepared = {
  prepareExecutionId: ExecutionId,
  approvalExecutionId: ExecutionId,
  prepared: Schema.String,
}
const publishing = { ...prepared, publishExecutionId: ExecutionId }
export const DemoData = Schema.TaggedUnion({
  allocatingPublish: prepared,
  approval: prepared,
  completed: { ...publishing, result: Schema.String },
  prepare: { prepareExecutionId: ExecutionId },
  publish: publishing,
})
type DemoLabels = Readonly<{ prepare: string; publish: string }>
const stateConfig = (labels: DemoLabels) =>
  ({
    // Native document order defines graph node order and snapshot active-state order.
    states: {
      Ready: {},
      prepare: DemoData.cases.prepare.annotate({ description: 'task', title: labels.prepare }),
      approval: DemoData.cases.approval.annotate({ description: 'checkpoint', title: 'Manual approval' }),
      allocatingPublish: DemoData.cases.allocatingPublish,
      publish: DemoData.cases.publish.annotate({ description: 'task', title: labels.publish }),
      completed: { schema: DemoData.cases.completed, type: 'final' },
    },
  }) as const
type DemoStateConfig = ReturnType<typeof stateConfig>
export const demoStates = (labels: DemoLabels): ReturnType<typeof Machine.state<DemoStateConfig>> =>
  Machine.state(stateConfig(labels))
const states = demoStates({ prepare: '', publish: '' })
export type DemoNativeState = Machine.Snapshot<typeof states>
type NodeDraft = Pick<Extract<EventDraft, { type: 'node.started' }>, 'attempt' | 'executionId' | 'nodeId'>
export const nodeEvent = (nodeId: string, executionId: ExecutionId): NodeDraft => ({ attempt: 1, executionId, nodeId })

type ApprovalData = Pick<typeof DemoData.cases.approval.Type, 'approvalExecutionId' | 'prepareExecutionId' | 'prepared'>

export const approvalData = (
  state:
    | typeof DemoData.cases.approval.Type
    | typeof DemoData.cases.allocatingPublish.Type
    | typeof DemoData.cases.publish.Type,
): ApprovalData => ({
  approvalExecutionId: state.approvalExecutionId,
  prepareExecutionId: state.prepareExecutionId,
  prepared: state.prepared,
})
type Published = Omit<typeof DemoData.cases.completed.Type, '_tag'>
export const publish = (
  state: typeof DemoData.cases.publish.Type,
): Effect.Effect<Published, never, WorkflowCheckpoint> =>
  Effect.gen(function* () {
    const checkpoint = yield* WorkflowCheckpoint
    yield* checkpoint.checkpoint([
      { type: 'node.succeeded', ...nodeEvent('approval', state.approvalExecutionId), payload: { approved: true } },
      { type: 'node.started', ...nodeEvent('publish', state.publishExecutionId), payload: {} },
    ])
    return {
      ...approvalData(state),
      publishExecutionId: state.publishExecutionId,
      result: `published:${state.prepared}`,
    }
  })

export const demoStatus = (state: DemoNativeState): RunStatus => {
  if (states.matches(state, 'Ready')) {
    return 'pending'
  }
  if (states.matches(state, 'approval')) {
    return 'waiting'
  }
  return states.matches(state, 'completed') ? 'completed' : 'running'
}
export const demoBoundary = (state: DemoNativeState): boolean =>
  states.matches(state, 'approval') || states.matches(state, 'completed')
export const demoBoundaryEvents = (state: DemoNativeState): Readonly<EventDraft[]> => {
  if (states.matches(state, 'approval')) {
    const data = Option.getOrThrow(states.get(state, 'approval'))
    return [
      { type: 'node.succeeded', ...nodeEvent('prepare', data.prepareExecutionId), payload: { output: data.prepared } },
      { type: 'node.started', ...nodeEvent('approval', data.approvalExecutionId), payload: {} },
      { type: 'run.waiting', ...nodeEvent('approval', data.approvalExecutionId), payload: {} },
    ]
  }
  if (states.matches(state, 'completed')) {
    const data = Option.getOrThrow(states.get(state, 'completed'))
    return [
      { type: 'node.succeeded', ...nodeEvent('publish', data.publishExecutionId), payload: { output: data.result } },
      { payload: {}, type: 'run.completed' },
    ]
  }
  return []
}
export const demoRuntimeError = (cause: unknown): ExternalError =>
  new ExternalError({ cause, kind: 'service', operation: 'demo native machine' })
export const invalidDemoSnapshot = (): InvalidSnapshot =>
  new InvalidSnapshot({ message: 'Invalid native demo machine snapshot' })
