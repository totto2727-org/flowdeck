import { live } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

import { allocationGraph, alternativeGraph, executableGraph, resume } from './graph-machine.fixture.ts'
import { projectMachineGraph } from './graph.ts'

describe('executable native Machine graph', () => {
  live('projects the same completion edge that automatically invokes the next business node', () =>
    Effect.gen(function* () {
      const execute = vi.fn<(phase: string) => void>()
      const native = yield* executableGraph(execute)
      const graph = projectMachineGraph({
        graphId: 'executable-graph-1',
        nodes: Machine.stateNodes(native),
        transitions: Machine.transitionDefinitions(native),
      })
      expect(execute).not.toHaveBeenCalled()
      expect(graph.nodes).toStrictEqual([
        { kind: 'task', label: 'Implement task', nodeId: 'implement' },
        { kind: 'task', label: 'Verify task', nodeId: 'verify' },
      ])
      expect(graph.edges).toStrictEqual([
        { edgeId: 'implement-verify', label: 'implementation complete', source: 'implement', target: 'verify' },
      ])
      yield* Effect.gen(function* () {
        const ref = yield* Machine.start(native)
        yield* ref.join
      }).pipe(Effect.scoped, Effect.timeout('2 seconds'))
      expect(execute.mock.calls).toStrictEqual([['implement'], ['verify']])
    }),
  )
})

describe('unannotated native Machine graph paths', () => {
  live('projects through allocation invokes without executing them during introspection', () =>
    Effect.gen(function* () {
      const allocate = vi.fn<() => void>()
      const native = yield* allocationGraph(allocate)
      const graph = projectMachineGraph({
        graphId: 'allocation-1',
        nodes: Machine.stateNodes(native),
        transitions: Machine.transitionDefinitions(native),
      })
      expect(graph.edges).toStrictEqual([
        { edgeId: 'approval-publish', label: 'Resume', source: 'approval', target: 'publish' },
      ])
      expect(allocate).not.toHaveBeenCalled()
      yield* Effect.gen(function* () {
        const ref = yield* Machine.start(native)
        yield* ref.send(resume)
        yield* ref.join
      }).pipe(Effect.scoped, Effect.timeout('2 seconds'))
      expect(allocate).toHaveBeenCalledOnce()
    }),
  )

  test('combines native alternatives between the same visible nodes in declared order', () => {
    const native = alternativeGraph
    const graph = projectMachineGraph({
      graphId: 'alternatives-graph-1',
      nodes: Machine.stateNodes(native),
      transitions: Machine.transitionDefinitions(native),
    })
    expect(graph.edges).toStrictEqual([
      { edgeId: 'approval-publish', label: 'Resume, Approve', source: 'approval', target: 'publish' },
    ])
  })
})
