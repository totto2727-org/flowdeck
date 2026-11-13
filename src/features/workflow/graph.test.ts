import { Machine } from '@typeonce/effect-machine'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { projectMachineGraph } from './graph'

const states = Machine.state({
  states: {
    implement: {
      annotations: { title: 'Implement task', description: 'task' },
      states: { submit: {}, accepted: { type: 'final' } },
    },
    verify: { annotations: { title: 'Verify task', description: 'task' } },
    completed: { type: 'final' },
  },
})
const makeWorkflow = (execute: (phase: string) => void) =>
  Machine.make({
    id: 'executable-graph',
    root: states,
    events: Machine.events({}),
    effects: {
      implement: Effect.sync(() => execute('implement')),
      verify: Effect.sync(() => execute('verify')),
    },
    branches: { handoff: { verify: { target: 'verify', title: 'implementation complete' } } },
  }).handle({
    initial: { target: 'implement' },
    states: {
      implement: {
        initial: { target: 'implement.submit' },
        states: {
          submit: { invoke: { src: 'implement', onDone: { target: 'implement.accepted' } } },
          accepted: {},
        },
        onDone: { branches: 'handoff', resolve: ({ select }) => select.verify() },
      },
      verify: { invoke: { src: 'verify', onDone: { target: 'completed' } } },
      completed: {},
    },
  })

describe('executable native Machine graph', () => {
  it('projects the same native completion edge that automatically invokes the next business node', async () => {
    const execute = vi.fn()
    const native = makeWorkflow(execute)
    const graph = projectMachineGraph({
      graphId: 'executable-graph-1',
      nodes: Machine.stateNodes(native),
      transitions: Machine.transitionDefinitions(native),
    })
    expect(execute).not.toHaveBeenCalled()
    expect(graph.nodes).toEqual([
      { nodeId: 'implement', label: 'Implement task', kind: 'task' },
      { nodeId: 'verify', label: 'Verify task', kind: 'task' },
    ])
    expect(graph.edges).toEqual([
      { edgeId: 'implement-verify', source: 'implement', target: 'verify', label: 'implementation complete' },
    ])
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* Machine.start(native)
          yield* ref.join
        }),
      ).pipe(Effect.timeout('2 seconds')),
    )
    expect(execute.mock.calls).toEqual([['implement'], ['verify']])
  })

  it('projects through unannotated native allocation invokes without executing them during introspection', async () => {
    const allocate = vi.fn()
    const root = Machine.state({
      states: {
        approval: { annotations: { title: 'Approval', description: 'checkpoint' } },
        allocate: {},
        publish: { annotations: { title: 'Publish', description: 'task' } },
        completed: { type: 'final' },
      },
    })
    const native = Machine.make({
      root,
      events: Machine.events({ Resume: {} }),
      effects: {
        allocate: Effect.sync(allocate),
        publish: Effect.void,
      },
    }).handle({
      initial: { target: 'approval' },
      states: {
        approval: { on: { Resume: { target: 'allocate' } } },
        allocate: { invoke: { src: 'allocate', onDone: { target: 'publish' } } },
        publish: { invoke: { src: 'publish', onDone: { target: 'completed' } } },
        completed: {},
      },
    })
    expect(
      projectMachineGraph({
        graphId: 'allocation-1',
        nodes: Machine.stateNodes(native),
        transitions: Machine.transitionDefinitions(native),
      }).edges,
    ).toEqual([{ edgeId: 'approval-publish', source: 'approval', target: 'publish', label: 'Resume' }])
    expect(allocate).not.toHaveBeenCalled()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* Machine.start(native)
          yield* ref.send({ _tag: 'Resume' })
          yield* ref.join
        }),
      ).pipe(Effect.timeout('2 seconds')),
    )
    expect(allocate).toHaveBeenCalledTimes(1)
  })

  it('combines native alternatives between the same visible nodes without adding a second topology', () => {
    const root = Machine.state({
      states: {
        approval: { annotations: { title: 'Approval', description: 'checkpoint' } },
        publish: { annotations: { title: 'Publish', description: 'task' } },
        completed: { type: 'final' },
      },
    })
    const events = Machine.events({ Resume: {}, Approve: {} })
    const native = Machine.make({ root, events }).handle({
      initial: { target: 'approval' },
      states: {
        approval: { on: { Resume: { target: 'publish' }, Approve: { target: 'publish' } } },
        publish: {},
        completed: {},
      },
    })
    const graph = projectMachineGraph({
      graphId: 'alternatives-graph-1',
      nodes: Machine.stateNodes(native),
      transitions: Machine.transitionDefinitions(native),
    })
    expect(graph.edges).toEqual([
      { edgeId: 'approval-publish', source: 'approval', target: 'publish', label: 'Resume, Approve' },
    ])
  })
})
