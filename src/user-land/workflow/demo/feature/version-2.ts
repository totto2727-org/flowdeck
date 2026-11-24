import { Machine } from '@typeonce/effect-machine'
import { Crypto, Effect, Schema } from 'effect'

import type { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { makeExecutionId } from '@/core/feature/workflow/domain/identity'
import { JsonObject } from '@/core/feature/workflow/domain/model'
import { projectMachineGraph } from '@/core/feature/workflow/graph'
import { ResumeEvent, WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'

import { demoVersion2 } from './input.ts'
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
export const demoVersion2States = demoStates({ prepare: 'Enrich release', publish: 'Publish enriched release' })
export const demoVersion2Machine = Machine.make({
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
          prepared: 'draft:v2:reviewed',
        }
      }),
    publish,
  },
  events: Machine.eventsFromSchemas(ResumeEvent),
  id: 'demo-2.0.0',
  root: demoVersion2States,
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
export const decodeDemoVersion2 = (
  encoded: JsonObject,
): Effect.Effect<Machine.Snapshot<typeof demoVersion2States>, InvalidSnapshot> =>
  Machine.decodeSnapshot(demoVersion2Machine, encoded).pipe(Effect.mapError(invalidDemoSnapshot))
export const encodeDemoVersion2 = (
  state: Machine.Snapshot<typeof demoVersion2States>,
): Effect.Effect<JsonObject, InvalidSnapshot> =>
  Machine.encodeSnapshot(demoVersion2Machine, state).pipe(
    Effect.flatMap(decodeJson),
    Effect.mapError(invalidDemoSnapshot),
  )
export const initialDemoVersion2: Effect.Effect<JsonObject> = Machine.planInitial(demoVersion2Machine).pipe(
  Effect.flatMap((initial) => encodeDemoVersion2(initial.state)),
  Effect.orDie,
)
export const demoVersion2Definition = {
  graph: projectMachineGraph({
    graphId: 'demo-2_0_0-graph-1',
    nodes: Machine.stateNodes(demoVersion2Machine),
    transitions: Machine.transitionDefinitions(demoVersion2Machine),
  }),
  program: Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    return {
      boundaryEvents: demoBoundaryEvents,
      decode: decodeDemoVersion2,
      encode: encodeDemoVersion2,
      isReplyBoundary: demoBoundary,
      mapError: demoRuntimeError,
      resume: (state: Machine.Snapshot<typeof demoVersion2States>) =>
        Machine.resume(demoVersion2Machine, state).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      start: (_state: Machine.Snapshot<typeof demoVersion2States>) =>
        Machine.start(demoVersion2Machine).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      status: demoStatus,
    }
  }),
  version: demoVersion2,
  workflowId: 'demo',
}
