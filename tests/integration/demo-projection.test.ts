import { Array, DateTime, HashMap, Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { NodeId } from '@/core/feature/workflow/domain/identity'
import type { EventType, RunEvent } from '@/core/feature/workflow/domain/model'
import { graphToShapes, projectEvents } from '@/core/feature/workflow/domain/projection'
import { demoGraph } from '@/user-land/workflow/demo/feature/demo'
import { demoVersion1, demoVersion2 } from '@/user-land/workflow/demo/feature/input'

type NodeEventType = Extract<EventType, 'node.started' | 'node.succeeded' | 'node.failed' | 'run.waiting'>
const event = (sequence: number, nodeId: NodeId, type: NodeEventType): Extract<RunEvent, { type: NodeEventType }> => ({
  attempt: 1,
  createdAt: DateTime.makeUnsafe('2026-10-17T12:00:00.000Z'),
  eventId: `event_00000000-0000-4000-8000-00000000000${sequence}`,
  executionId: `execution_00000000-0000-4000-8000-00000000000${sequence}`,
  nodeId,
  payload: {},
  runId: 'run_00000000-0000-4000-8000-000000000001',
  sequence,
  type,
})

describe('graph projections', () => {
  test.each([demoVersion1, demoVersion2])(
    'creates stable node and edge geometry without mutating the %s version graph',
    (version) => {
      const graph = demoGraph(version)
      const shapes = graphToShapes(graph)
      expect(
        Array.map(shapes.nodes, (node) => ({ id: node.nodeId, state: node.state, x: node.position.x })),
      ).toStrictEqual([
        { id: 'prepare', state: 'idle', x: 48 },
        { id: 'approval', state: 'idle', x: 328 },
        { id: 'publish', state: 'idle', x: 608 },
      ])
      expect(Array.map(shapes.edges, (edge) => edge.traversed)).toStrictEqual([false, false])
      expect(graph).toStrictEqual(demoGraph(version))
    },
  )

  test('uses sequence order rather than delivery order or wall clock time', () => {
    const projection = projectEvents([
      event(3, 'prepare', 'node.succeeded'),
      event(1, 'prepare', 'node.started'),
      event(2, 'approval', 'run.waiting'),
    ])
    expect(HashMap.get(projection, 'prepare')).toStrictEqual(Option.some('succeeded'))
    expect(HashMap.get(projection, 'approval')).toStrictEqual(Option.some('waiting'))
  })

  test('retains a traversed edge while a previously successful source is active in a later attempt', () => {
    const shapes = graphToShapes(demoGraph(demoVersion1), [
      event(1, 'prepare', 'node.succeeded'),
      event(2, 'approval', 'node.started'),
      event(3, 'approval', 'run.waiting'),
      {
        ...event(4, 'prepare', 'node.started'),
        attempt: 2,
        executionId: 'execution_00000000-0000-4000-8000-000000000004',
      },
    ])
    expect(Array.map(shapes.nodes, (node) => node.state)).toStrictEqual(['running', 'waiting', 'idle'])
    expect(Array.map(shapes.edges, (edge) => edge.traversed)).toStrictEqual([true, false])
  })
})
