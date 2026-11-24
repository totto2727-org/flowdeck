import { Machine } from '@typeonce/effect-machine'
import { Crypto, Effect, Schema } from 'effect'

import type { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { makeExecutionId } from '@/core/feature/workflow/domain/identity'
import { JsonObject } from '@/core/feature/workflow/domain/model'
import { projectMachineGraph } from '@/core/feature/workflow/graph'
import { ResumeEvent, WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'

import { demoVersion1 } from './input.ts'
import {
  approvalData,
  demoBoundary,
  demoBoundaryEvents,
  demoStates,
  demoStatus,
  demoRuntimeError,
  invalidDemoSnapshot,
  nodeEvent,
  publish,
} from './node.ts'
import type { DemoData } from './node.ts'

// Crypto failures are infrastructure defects, never business-state transitions.
const allocateExecution = makeExecutionId.pipe(Effect.orDie)
export const demoVersion1States = demoStates({ prepare: 'Prepare release', publish: 'Publish release' })
export const demoVersion1Machine = Machine.make({
  effects: {
    allocatePrepare: allocateExecution,
    allocatePublish: (state: typeof DemoData.cases.allocatingPublish.Type) =>
      allocateExecution.pipe(Effect.map((publishExecutionId) => ({ ...approvalData(state), publishExecutionId }))),
    prepare: (state: typeof DemoData.cases.prepare.Type) =>
      Effect.gen(function* () {
        const checkpoint = yield* WorkflowCheckpoint
        yield* checkpoint.checkpoint([
          { payload: {}, type: 'run.started' },
          { type: 'node.started', ...nodeEvent('prepare', state.prepareExecutionId), payload: {} },
        ])
        return {
          approvalExecutionId: yield* allocateExecution,
          prepareExecutionId: state.prepareExecutionId,
          prepared: 'draft:v1',
        }
      }),
    publish,
  },
  events: Machine.eventsFromSchemas(ResumeEvent),
  id: 'demo-1.0.0',
  root: demoVersion1States,
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: {
      invoke: {
        onDone: { data: ({ output }) => ({ prepareExecutionId: output }), target: 'prepare' },
        src: 'allocatePrepare',
      },
    },
    allocatingPublish: {
      invoke: {
        input: ({ state }) => state,
        onDone: { data: ({ output }) => output, target: 'publish' },
        src: 'allocatePublish',
      },
    },
    approval: { on: { Resume: { data: ({ state }) => approvalData(state), target: 'allocatingPublish' } } },
    completed: {},
    prepare: {
      invoke: {
        input: ({ state }) => state,
        onDone: { data: ({ output }) => output, target: 'approval' },
        src: 'prepare',
      },
    },
    publish: {
      invoke: {
        input: ({ state }) => state,
        onDone: { data: ({ output }) => output, target: 'completed' },
        src: 'publish',
      },
    },
  },
})
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The machine encoder produces an unchecked wire object.
const decodeJson = Schema.decodeUnknownEffect(JsonObject)
export const decodeDemoVersion1 = (
  encoded: JsonObject,
): Effect.Effect<Machine.Snapshot<typeof demoVersion1States>, InvalidSnapshot> =>
  Machine.decodeSnapshot(demoVersion1Machine, encoded).pipe(Effect.mapError(invalidDemoSnapshot))
export const encodeDemoVersion1 = (
  state: Machine.Snapshot<typeof demoVersion1States>,
): Effect.Effect<JsonObject, InvalidSnapshot> =>
  Machine.encodeSnapshot(demoVersion1Machine, state).pipe(
    Effect.flatMap(decodeJson),
    Effect.mapError(invalidDemoSnapshot),
  )
export const initialDemoVersion1: Effect.Effect<JsonObject> = Machine.planInitial(demoVersion1Machine).pipe(
  Effect.flatMap((initial) => encodeDemoVersion1(initial.state)),
  Effect.orDie,
)
export const demoVersion1Definition = {
  graph: projectMachineGraph({
    graphId: 'demo-1_0_0-graph-1',
    nodes: Machine.stateNodes(demoVersion1Machine),
    transitions: Machine.transitionDefinitions(demoVersion1Machine),
  }),
  program: Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    return {
      boundaryEvents: demoBoundaryEvents,
      decode: decodeDemoVersion1,
      encode: encodeDemoVersion1,
      isReplyBoundary: demoBoundary,
      mapError: demoRuntimeError,
      resume: (state: Machine.Snapshot<typeof demoVersion1States>) =>
        Machine.resume(demoVersion1Machine, state).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      start: (_state: Machine.Snapshot<typeof demoVersion1States>) =>
        Machine.start(demoVersion1Machine).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      status: demoStatus,
    }
  }),
  version: demoVersion1,
  workflowId: 'demo',
}
