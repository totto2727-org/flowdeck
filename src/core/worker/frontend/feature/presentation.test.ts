import { Array, Option, Predicate, String } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { ExecutionId, NodeId } from '@/core/feature/workflow/domain/identity'
import type { RunStatus, Shapes } from '@/core/feature/workflow/domain/model'

import {
  eventLabel,
  graphSize,
  latestExecution,
  nextNode,
  nodeEvents,
  orderedEvents,
  renderJson,
  runRecoveryAction,
  shortId,
} from './presentation.ts'
import type { RunEvent } from './view-model.ts'

const firstExecution = 'execution_00000000-0000-4000-8000-000000000001'
const secondExecution = 'execution_00000000-0000-4000-8000-000000000002'
const runId = 'run_00000000-0000-4000-8000-000000000001'
const createdAt = '2026-10-17T00:00:00.000Z'
const idSuffixLength = 12
const event = (
  sequence: number,
  nodeId: NodeId,
  executionId: ExecutionId,
): Extract<RunEvent, { type: 'node.succeeded' }> => ({
  attempt: sequence,
  createdAt,
  eventId: `event_00000000-0000-4000-8000-${String.padStart(idSuffixLength, '0')(`${sequence}`)}`,
  executionId,
  nodeId,
  payload: {},
  runId,
  sequence,
  type: 'node.succeeded',
})

describe('run recovery actions', () => {
  const eligible: Readonly<{ action: 'recover' | 'resume'; status: RunStatus }[]> = [
    { action: 'recover', status: 'pending' },
    { action: 'recover', status: 'running' },
    { action: 'resume', status: 'waiting' },
  ]
  const terminal: Readonly<RunStatus[]> = ['completed', 'failed']

  test.each(eligible)('offers $action for a $status run', ({ action, status }) => {
    expect(runRecoveryAction(status)).toBe(action)
  })

  test.each(terminal)('offers no action for a %s run', (status) => {
    expect(runRecoveryAction(status)).toBeUndefined()
  })
})

describe('keyboard node navigation', () => {
  const nodes = ['prepare', 'approval', 'publish']
  const directions = [
    { current: 'prepare', key: 'ArrowRight', next: 'approval' },
    { current: 'approval', key: 'ArrowDown', next: 'publish' },
    { current: 'approval', key: 'ArrowUp', next: 'prepare' },
    { current: 'prepare', key: 'ArrowLeft', next: 'prepare' },
    { current: 'publish', key: 'ArrowRight', next: 'publish' },
    { current: 'approval', key: 'Home', next: 'prepare' },
    { current: 'approval', key: 'End', next: 'publish' },
  ]

  test.each(directions)('focuses $next on $key from $current', ({ current, key, next }) => {
    expect(nextNode(nodes, current, key)).toBe(next)
  })

  test('leaves Tab and empty graphs to the browser', () => {
    expect(nextNode(nodes, 'approval', 'Tab')).toBeUndefined()
    expect(nextNode([], 'missing', 'ArrowRight')).toBeUndefined()
  })
})

describe('workflow events', () => {
  test('sorts persisted sequence without mutating events and retains repeated executions', () => {
    const runEvent: RunEvent = {
      createdAt,
      eventId: 'event_00000000-0000-4000-8000-000000000004',
      payload: {},
      runId,
      sequence: 1,
      type: 'run.started',
    }
    const events = [event(3, 'prepare', secondExecution), runEvent, event(2, 'prepare', firstExecution)]
    const executions = Array.filter(nodeEvents(events, 'prepare'), Predicate.hasProperty('executionId'))
    expect(Array.map(orderedEvents(events), (item) => item.sequence)).toStrictEqual([1, 2, 3])
    expect(Array.map(executions, (item) => item.executionId)).toStrictEqual([firstExecution, secondExecution])
    expect(Array.getUnsafe(events, 0).sequence).toBe(3)
    expect(nodeEvents(events, 'unknown')).toStrictEqual([])
  })

  test('retains the node execution when a later checkpoint references the same execution', () => {
    const started = { ...event(2, 'approval', firstExecution), type: 'node.started' as const }
    const waiting = { ...event(3, 'approval', firstExecution), type: 'run.waiting' as const }
    const execution = Option.getOrUndefined(latestExecution([waiting, started]))
    expect(execution).toMatchObject({ attempt: 2, executionId: firstExecution })
    expect(Option.isNone(latestExecution([waiting]))).toBe(true)
  })
})

describe('graph bounds', () => {
  test('uses minimum bounds for an empty graph', () => {
    expect(graphSize({ edges: [], nodes: [] })).toStrictEqual({ height: 220, width: 560 })
  })

  test('derives bounds from common shapes', () => {
    const shapes: Shapes = {
      edges: [],
      nodes: [
        {
          id: 'node',
          kind: 'task',
          label: 'Node',
          nodeId: 'node',
          position: { x: 900, y: 400 },
          size: { height: 90, width: 180 },
          state: 'waiting',
          type: 'node',
        },
      ],
    }
    expect(graphSize(shapes)).toStrictEqual({ height: 530, width: 1120 })
  })
})

describe('display formatting', () => {
  test('formats identifiers and event names', () => {
    expect(shortId('run_00000000-0000-4000-8000-001234567890')).toBe('34567890')
    expect(eventLabel('node.succeeded')).toBe('node succeeded')
  })

  test('preserves payload property order in formatted JSON', () => {
    // Exercise the insertion order seen in the event payload.
    expect(renderJson({ state: 'Waiting', revision: 2 })).toBe('{\n  "state": "Waiting",\n  "revision": 2\n}')
  })
})
