import { Machine } from '@typeonce/effect-machine'
import { Crypto, Effect, Schema } from 'effect'

import { makeExecutionId } from '@/core/feature/workflow/domain/identity'
import { JsonObject } from '@/core/feature/workflow/domain/model'
import { projectMachineGraph } from '@/core/feature/workflow/graph'
import { ResumeEvent, WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'

import { demoVersion1 } from './input'
import {
  approvalData,
  DemoData,
  demoBoundary,
  demoBoundaryEvents,
  demoStates,
  demoStatus,
  demoRuntimeError,
  invalidDemoSnapshot,
  nodeEvent,
  publish,
} from './node'

// Crypto failures are infrastructure defects, never business-state transitions.
const allocateExecution = makeExecutionId.pipe(Effect.orDie)
export const demoVersion1States = demoStates({ prepare: 'Prepare release', publish: 'Publish release' })
export const demoVersion1Machine = Machine.make({
  id: 'demo-1.0.0',
  root: demoVersion1States,
  events: Machine.eventsFromSchemas(ResumeEvent),
  effects: {
    allocatePrepare: allocateExecution,
    prepare: (state: typeof DemoData.cases.prepare.Type) =>
      Effect.gen(function* () {
        const checkpoint = yield* WorkflowCheckpoint
        yield* checkpoint.checkpoint([
          { type: 'run.started', payload: {} },
          { type: 'node.started', ...nodeEvent('prepare', state.prepareExecutionId), payload: {} },
        ])
        return {
          prepareExecutionId: state.prepareExecutionId,
          prepared: 'draft:v1',
          approvalExecutionId: yield* allocateExecution,
        }
      }),
    allocatePublish: (state: typeof DemoData.cases.allocatingPublish.Type) =>
      allocateExecution.pipe(Effect.map((publishExecutionId) => ({ ...approvalData(state), publishExecutionId }))),
    publish,
  },
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: {
      invoke: {
        src: 'allocatePrepare',
        onDone: { target: 'prepare', data: ({ output }) => ({ prepareExecutionId: output }) },
      },
    },
    prepare: {
      invoke: {
        src: 'prepare',
        input: ({ state }) => state,
        onDone: { target: 'approval', data: ({ output }) => output },
      },
    },
    approval: { on: { Resume: { target: 'allocatingPublish', data: ({ state }) => approvalData(state) } } },
    allocatingPublish: {
      invoke: {
        src: 'allocatePublish',
        input: ({ state }) => state,
        onDone: { target: 'publish', data: ({ output }) => output },
      },
    },
    publish: {
      invoke: {
        src: 'publish',
        input: ({ state }) => state,
        onDone: { target: 'completed', data: ({ output }) => output },
      },
    },
    completed: {},
  },
})
const decodeJson = Schema.decodeUnknownEffect(JsonObject)
export const decodeDemoVersion1 = (encoded: JsonObject) =>
  Machine.decodeSnapshot(demoVersion1Machine, encoded).pipe(Effect.mapError(invalidDemoSnapshot))
export const encodeDemoVersion1 = (state: Machine.Snapshot<typeof demoVersion1States>) =>
  Machine.encodeSnapshot(demoVersion1Machine, state).pipe(
    Effect.flatMap(decodeJson),
    Effect.mapError(invalidDemoSnapshot),
  )
export const initialDemoVersion1 = Effect.runSync(Machine.planInitial(demoVersion1Machine)).state
export const demoVersion1Definition = {
  workflowId: 'demo',
  version: demoVersion1,
  graph: projectMachineGraph({
    graphId: 'demo-1_0_0-graph-1',
    nodes: Machine.stateNodes(demoVersion1Machine),
    transitions: Machine.transitionDefinitions(demoVersion1Machine),
  }),
  program: Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    return {
      decode: decodeDemoVersion1,
      encode: encodeDemoVersion1,
      start: (_state: Machine.Snapshot<typeof demoVersion1States>) =>
        Machine.start(demoVersion1Machine).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      resume: (state: Machine.Snapshot<typeof demoVersion1States>) =>
        Machine.resume(demoVersion1Machine, state).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      isReplyBoundary: demoBoundary,
      status: demoStatus,
      boundaryEvents: demoBoundaryEvents,
      mapError: demoRuntimeError,
    }
  }),
}
