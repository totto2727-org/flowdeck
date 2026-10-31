import { Array, Option, String } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type { ExecutionId, NodeId } from '../../../features/workflow/domain/identity'
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
} from './presentation'
import type { RunEvent } from './view-model'

const firstExecution = 'execution_00000000-0000-4000-8000-000000000001'
const secondExecution = 'execution_00000000-0000-4000-8000-000000000002'
const event = (
  sequence: number,
  nodeId: NodeId,
  executionId: ExecutionId,
): Extract<RunEvent, { type: 'node.succeeded' }> => ({
  eventId: `event_00000000-0000-4000-8000-${String.padStart(12, '0')(`${sequence}`)}`,
  runId: 'run_00000000-0000-4000-8000-000000000001',
  sequence,
  nodeId,
  executionId,
  attempt: sequence,
  type: 'node.succeeded',
  payload: {},
  createdAt: '2026-10-17T00:00:00.000Z',
})

describe('workflow presentation', () => {
  it('offers explicit recovery only for nonterminal runs', () => {
    expect(runRecoveryAction('pending')).toBe('recover')
    expect(runRecoveryAction('running')).toBe('recover')
    expect(runRecoveryAction('waiting')).toBe('resume')
    expect(runRecoveryAction('completed')).toBeNull()
    expect(runRecoveryAction('failed')).toBeNull()
  })

  it('keeps keyboard node navigation bounded and supports both axes', () => {
    const nodes = ['prepare', 'approval', 'publish']
    expect(nextNode(nodes, 'prepare', 'ArrowRight')).toBe('approval')
    expect(nextNode(nodes, 'approval', 'ArrowDown')).toBe('publish')
    expect(nextNode(nodes, 'approval', 'ArrowUp')).toBe('prepare')
    expect(nextNode(nodes, 'prepare', 'ArrowLeft')).toBe('prepare')
    expect(nextNode(nodes, 'publish', 'ArrowRight')).toBe('publish')
    expect(nextNode(nodes, 'approval', 'Home')).toBe('prepare')
    expect(nextNode(nodes, 'approval', 'End')).toBe('publish')
    expect(nextNode(nodes, 'approval', 'Tab')).toBeUndefined()
    expect(nextNode([], 'missing', 'ArrowRight')).toBeUndefined()
  })

  it('sorts persisted sequence without mutating events and retains repeated executions', () => {
    const runEvent: RunEvent = {
      eventId: 'event_00000000-0000-4000-8000-000000000004',
      runId: 'run_00000000-0000-4000-8000-000000000001',
      sequence: 1,
      type: 'run.started',
      payload: {},
      createdAt: '2026-10-17T00:00:00.000Z',
    }
    const events = [event(3, 'prepare', secondExecution), runEvent, event(2, 'prepare', firstExecution)]
    expect(Array.map(orderedEvents(events), (item) => item.sequence)).toEqual([1, 2, 3])
    expect(
      Array.map(nodeEvents(events, 'prepare'), (item) => ('executionId' in item ? item.executionId : undefined)),
    ).toEqual([firstExecution, secondExecution])
    expect(Array.getUnsafe(events, 0).sequence).toBe(3)
    expect(nodeEvents(events, 'unknown')).toEqual([])
  })

  it('retains the node execution when a later checkpoint references the same execution', () => {
    const started = { ...event(2, 'approval', firstExecution), type: 'node.started' as const }
    const waiting = { ...event(3, 'approval', firstExecution), type: 'run.waiting' as const }
    const execution = Option.getOrUndefined(latestExecution([waiting, started]))
    expect(execution?.executionId).toBe(firstExecution)
    expect(execution?.attempt).toBe(2)
    expect(Option.isNone(latestExecution([waiting]))).toBe(true)
  })

  it('derives graph bounds from common shapes without workflow-specific coordinates', () => {
    expect(graphSize({ nodes: [], edges: [] })).toEqual({ width: 560, height: 220 })
    expect(
      graphSize({
        nodes: [
          {
            id: 'node',
            nodeId: 'node',
            type: 'node',
            label: 'Node',
            kind: 'task',
            position: { x: 900, y: 400 },
            size: { width: 180, height: 90 },
            state: 'waiting',
          },
        ],
        edges: [],
      }),
    ).toEqual({ width: 1120, height: 530 })
  })

  it('formats identifiers and event names with Effect String', () => {
    expect(shortId('run_00000000-0000-4000-8000-001234567890')).toBe('34567890')
    expect(eventLabel('node.succeeded')).toBe('node succeeded')
    expect(renderJson({ state: 'Waiting', revision: 2 })).toBe('{\n  "state": "Waiting",\n  "revision": 2\n}')
  })
})
