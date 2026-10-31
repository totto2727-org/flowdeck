import { Array, DateTime, HashMap, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { demoGraph } from '../../../workers/demo-workflow/features/demo'
import { demoVersion1, demoVersion2 } from '../../../workers/demo-workflow/features/input'
import type { NodeId } from './identity'
import type { EventType, RunEvent } from './model'
import { graphToShapes, projectEvents } from './projection'

type NodeEventType = Extract<EventType, 'node.started' | 'node.succeeded' | 'node.failed' | 'run.waiting'>
const event = (sequence: number, nodeId: NodeId, type: NodeEventType): Extract<RunEvent, { type: NodeEventType }> => ({
  eventId: `event_00000000-0000-4000-8000-00000000000${sequence}`,
  runId: 'run_00000000-0000-4000-8000-000000000001',
  sequence,
  nodeId,
  executionId: `execution_00000000-0000-4000-8000-00000000000${sequence}`,
  attempt: 1,
  type,
  payload: {},
  createdAt: DateTime.makeUnsafe('2026-10-17T12:00:00.000Z'),
})

describe('graph projections', () => {
  it.each([demoVersion1, demoVersion2])(
    'creates stable node and edge geometry without mutating the %s version graph',
    (version) => {
      const graph = demoGraph(version)
      const shapes = graphToShapes(graph)
      expect(Array.map(shapes.nodes, (node) => ({ id: node.nodeId, state: node.state, x: node.position.x }))).toEqual([
        { id: 'prepare', state: 'idle', x: 48 },
        { id: 'approval', state: 'idle', x: 328 },
        { id: 'publish', state: 'idle', x: 608 },
      ])
      expect(Array.map(shapes.edges, (edge) => edge.traversed)).toEqual([false, false])
      expect(graph).toEqual(demoGraph(version))
    },
  )

  it('uses sequence order rather than delivery order or wall clock time', () => {
    const projection = projectEvents([
      event(3, 'prepare', 'node.succeeded'),
      event(1, 'prepare', 'node.started'),
      event(2, 'approval', 'run.waiting'),
    ])
    expect(HashMap.get(projection, 'prepare')).toEqual(Option.some('succeeded'))
    expect(HashMap.get(projection, 'approval')).toEqual(Option.some('waiting'))
  })

  it('retains a traversed edge while a previously successful source is active in a later attempt', () => {
    const shapes = graphToShapes(demoGraph(demoVersion1), [
      event(1, 'prepare', 'node.succeeded'),
      event(2, 'approval', 'node.started'),
      event(3, 'approval', 'run.waiting'),
      {
        ...event(4, 'prepare', 'node.started'),
        executionId: 'execution_00000000-0000-4000-8000-000000000004',
        attempt: 2,
      },
    ])
    expect(Array.map(shapes.nodes, (node) => node.state)).toEqual(['running', 'waiting', 'idle'])
    expect(Array.map(shapes.edges, (edge) => edge.traversed)).toEqual([true, false])
  })
})
