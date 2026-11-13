import { Machine } from '@typeonce/effect-machine'
import { Crypto, Effect, Schema } from 'effect'

import { makeExecutionId } from '@/features/workflow/domain/identity'
import { JsonObject } from '@/features/workflow/domain/model'
import { projectMachineGraph } from '@/features/workflow/graph'
import { ResumeEvent, WorkflowCheckpoint } from '@/features/workflow/managed-runtime'

import { demoVersion2 } from './input'
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
export const demoVersion2States = demoStates({ prepare: 'Enrich release', publish: 'Publish enriched release' })
export const demoVersion2Machine = Machine.make({
  id: 'demo-2.0.0',
  root: demoVersion2States,
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
          prepared: 'draft:v2:reviewed',
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
export const decodeDemoVersion2 = (encoded: JsonObject) =>
  Machine.decodeSnapshot(demoVersion2Machine, encoded).pipe(Effect.mapError(invalidDemoSnapshot))
export const encodeDemoVersion2 = (state: Machine.Snapshot<typeof demoVersion2States>) =>
  Machine.encodeSnapshot(demoVersion2Machine, state).pipe(
    Effect.flatMap(decodeJson),
    Effect.mapError(invalidDemoSnapshot),
  )
export const initialDemoVersion2 = Effect.runSync(Machine.planInitial(demoVersion2Machine)).state
export const demoVersion2Definition = {
  workflowId: 'demo',
  version: demoVersion2,
  graph: projectMachineGraph({
    graphId: 'demo-2_0_0-graph-1',
    nodes: Machine.stateNodes(demoVersion2Machine),
    transitions: Machine.transitionDefinitions(demoVersion2Machine),
  }),
  program: Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    return {
      decode: decodeDemoVersion2,
      encode: encodeDemoVersion2,
      start: (_state: Machine.Snapshot<typeof demoVersion2States>) =>
        Machine.start(demoVersion2Machine).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      resume: (state: Machine.Snapshot<typeof demoVersion2States>) =>
        Machine.resume(demoVersion2Machine, state).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      isReplyBoundary: demoBoundary,
      status: demoStatus,
      boundaryEvents: demoBoundaryEvents,
      mapError: demoRuntimeError,
    }
  }),
}
