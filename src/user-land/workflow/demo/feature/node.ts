import { Machine } from '@typeonce/effect-machine'
import { Effect, Option, Schema } from 'effect'

import { ExternalError, InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { ExecutionId } from '@/core/feature/workflow/domain/identity'
import { type RunStatus } from '@/core/feature/workflow/domain/model'
import { type EventDraft, WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'

const prepared = {
  prepareExecutionId: ExecutionId,
  approvalExecutionId: ExecutionId,
  prepared: Schema.String,
}
const publishing = { ...prepared, publishExecutionId: ExecutionId }
export const DemoData = Schema.TaggedUnion({
  prepare: { prepareExecutionId: ExecutionId },
  approval: prepared,
  allocatingPublish: prepared,
  publish: publishing,
  completed: { ...publishing, result: Schema.String },
})
export const demoStates = (labels: { readonly prepare: string; readonly publish: string }) =>
  Machine.state({
    states: {
      Ready: {},
      prepare: DemoData.cases.prepare.annotate({ title: labels.prepare, description: 'task' }),
      approval: DemoData.cases.approval.annotate({ title: 'Manual approval', description: 'checkpoint' }),
      allocatingPublish: DemoData.cases.allocatingPublish,
      publish: DemoData.cases.publish.annotate({ title: labels.publish, description: 'task' }),
      completed: { schema: DemoData.cases.completed, type: 'final' },
    },
  })
const states = demoStates({ prepare: '', publish: '' })
export type DemoNativeState = Machine.Snapshot<typeof states>
export const nodeEvent = (nodeId: string, executionId: ExecutionId) => ({ nodeId, executionId, attempt: 1 })

export const approvalData = (
  state:
    | typeof DemoData.cases.approval.Type
    | typeof DemoData.cases.allocatingPublish.Type
    | typeof DemoData.cases.publish.Type,
) => ({
  prepareExecutionId: state.prepareExecutionId,
  approvalExecutionId: state.approvalExecutionId,
  prepared: state.prepared,
})
export const publish = (state: typeof DemoData.cases.publish.Type) =>
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

export const demoStatus = (state: DemoNativeState): RunStatus =>
  states.matches(state, 'Ready')
    ? 'pending'
    : states.matches(state, 'approval')
      ? 'waiting'
      : states.matches(state, 'completed')
        ? 'completed'
        : 'running'
export const demoBoundary = (state: DemoNativeState) =>
  states.matches(state, 'approval') || states.matches(state, 'completed')
export const demoBoundaryEvents = (state: DemoNativeState): ReadonlyArray<EventDraft> => {
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
      { type: 'run.completed', payload: {} },
    ]
  }
  return []
}
export const demoRuntimeError = (cause: unknown) =>
  new ExternalError({ kind: 'service', operation: 'demo native machine', cause })
export const invalidDemoSnapshot = () => new InvalidSnapshot({ message: 'Invalid native demo machine snapshot' })
