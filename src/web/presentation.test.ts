import { Array, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type { RunEvent } from '../domain/model'
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

const event = (sequence: number, nodeId: string | null, executionId: string | null): RunEvent => ({
  eventId: `event-${sequence}`,
  runId: 'test-run',
  sequence,
  nodeId,
  executionId,
  attempt: executionId === null ? null : sequence,
  type: nodeId === null ? 'run.started' : 'node.succeeded',
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
    const events = [event(3, 'prepare', 'second'), event(1, null, null), event(2, 'prepare', 'first')]
    expect(Array.map(orderedEvents(events), (item) => item.sequence)).toEqual([1, 2, 3])
    expect(Array.map(nodeEvents(events, 'prepare'), (item) => item.executionId)).toEqual(['first', 'second'])
    expect(Array.getUnsafe(events, 0).sequence).toBe(3)
    expect(nodeEvents(events, 'unknown')).toEqual([])
  })

  it('retains the node execution when a later checkpoint event has no execution ID', () => {
    const started = { ...event(2, 'approval', 'approval-execution'), type: 'node.started' as const }
    const waiting = { ...event(3, 'approval', null), type: 'run.waiting' as const }
    const execution = Option.getOrUndefined(latestExecution([waiting, started]))
    expect(execution?.executionId).toBe('approval-execution')
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
            x: 900,
            y: 400,
            width: 180,
            height: 90,
            state: 'waiting',
          },
        ],
        edges: [],
      }),
    ).toEqual({ width: 1120, height: 530 })
  })

  it('formats identifiers and event names with Effect String', () => {
    expect(shortId('run-1234567890')).toBe('34567890')
    expect(eventLabel('node.succeeded')).toBe('node succeeded')
    expect(renderJson({ state: 'Waiting', revision: 2 })).toBe('{\n  "state": "Waiting",\n  "revision": 2\n}')
  })
})
