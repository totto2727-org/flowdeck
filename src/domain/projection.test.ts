import { Array, HashMap, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { demoGraph } from '../workflows/demo'
import type { EventType, RunEvent } from './model'
import { graphToShapes, projectEvents } from './projection'

const event = (sequence: number, nodeId: string, type: EventType): RunEvent => ({
  eventId: `event-${sequence}`,
  runId: 'run',
  sequence,
  nodeId,
  executionId: `run:${nodeId}:1`,
  attempt: 1,
  type,
  payload: {},
  createdAt: '2026-10-17T12:00:00.000Z',
})

describe('graph projections', () => {
  it('creates stable node and edge geometry without mutating the version graph', () => {
    const graph = demoGraph('v1')
    const shapes = graphToShapes(graph)
    expect(Array.map(shapes.nodes, (node) => ({ id: node.nodeId, state: node.state, x: node.x }))).toEqual([
      { id: 'prepare', state: 'idle', x: 48 },
      { id: 'approval', state: 'idle', x: 328 },
      { id: 'publish', state: 'idle', x: 608 },
    ])
    expect(Array.map(shapes.edges, (edge) => edge.traversed)).toEqual([false, false])
    expect(graph).toEqual(demoGraph('v1'))
  })

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
    const shapes = graphToShapes(demoGraph('v1'), [
      event(1, 'prepare', 'node.succeeded'),
      event(2, 'approval', 'node.started'),
      event(3, 'approval', 'run.waiting'),
      { ...event(4, 'prepare', 'node.started'), executionId: 'run:prepare:2', attempt: 2 },
    ])
    expect(Array.map(shapes.nodes, (node) => node.state)).toEqual(['running', 'waiting', 'idle'])
    expect(Array.map(shapes.edges, (edge) => edge.traversed)).toEqual([true, false])
  })
})
