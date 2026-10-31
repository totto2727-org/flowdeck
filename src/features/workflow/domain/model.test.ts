import { Array, DateTime, Schema, SemVer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CreateRun, GraphDefinition, NodeShape, Run, RunEvent, RunState, WorkflowVersion } from './model'

const uuid = '00000000-0000-4000-8000-000000000003'
const uuid7 = '01890f2e-7b55-7cc1-8c5a-000000000001'
const run = {
  runId: `run_${uuid}`,
  workflowId: 'demo',
  workflowVersion: '1.0.0',
  graphId: 'demo-1_0_0-graph-1',
  status: 'waiting',
  revision: 1,
  snapshot: {},
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
} as const
const state = { runId: run.runId, revision: 1, snapshot: {} }
const event = {
  eventId: `event_${uuid}`,
  runId: run.runId,
  sequence: 1,
  nodeId: 'prepare',
  executionId: `execution_${uuid}`,
  attempt: 1,
  type: 'node.started',
  payload: {},
  createdAt: run.createdAt,
} as const
const graph = {
  graphId: run.graphId,
  schemaVersion: 1,
  nodes: [{ nodeId: 'prepare', label: 'Prepare', kind: 'task' }],
  edges: [{ edgeId: 'prepare-approval', source: 'prepare', target: 'approval', label: 'Ready' }],
} as const
const unsafeIds = ['', '../demo', 'demo/workflow', 'two words', 'ワークフロー', 'demo:graph', 'demo.graph', 'node\n']
const runCodec = Schema.toCodecJson(Run)
const eventCodec = Schema.toCodecJson(RunEvent)
const createCodec = Schema.toCodecJson(CreateRun)
const decodeRun = Schema.decodeUnknownSync(runCodec)
const decodeEvent = Schema.decodeUnknownSync(eventCodec, { onExcessProperty: 'error' })
const decodeCreate = Schema.decodeUnknownSync(createCodec)
const decodeVersion = Schema.decodeUnknownSync(Schema.toCodecJson(WorkflowVersion))

describe('workflow-neutral wire schemas', () => {
  it('keeps rich domain versions and UTC timestamps separate from JSON', () => {
    const domain = decodeRun(run)
    expect(Schema.is(Run)(domain)).toBe(true)
    expect(Schema.is(Run)(run)).toBe(false)
    expect(DateTime.isUtc(domain.createdAt)).toBe(true)
    expect(DateTime.isUtc(domain.updatedAt)).toBe(true)
    expect(Schema.encodeSync(runCodec)(domain)).toEqual(run)
    expect(Schema.encodeSync(eventCodec)(decodeEvent(event))).toEqual(event)
    const input = { workflowId: 'demo', version: '1.0.0', title: 'Release' }
    expect(Schema.encodeSync(createCodec)(decodeCreate(input))).toEqual(input)
  })

  it.each(['createdAt', 'updatedAt'] as const)('rejects invalid run timestamp %s', (field) => {
    expect(() => decodeRun({ ...run, [field]: 'not-a-date' })).toThrow()
    expect(() => decodeRun({ ...run, [field]: null })).toThrow()
    expect(() => decodeEvent({ ...event, createdAt: 'not-a-date' })).toThrow()
  })

  it.each(['run.started', 'run.resumed', 'run.completed', 'run.failed'])('decodes %s without node identity', (type) => {
    const input = {
      eventId: event.eventId,
      runId: event.runId,
      sequence: 1,
      payload: {},
      createdAt: event.createdAt,
      type,
    }
    const decoded = decodeEvent(input)
    expect('nodeId' in decoded).toBe(false)
    expect('executionId' in decoded).toBe(false)
    expect('attempt' in decoded).toBe(false)
    expect(Schema.encodeSync(eventCodec)(decoded)).toEqual(input)
  })

  it.each(['node.started', 'node.succeeded', 'node.failed', 'run.waiting'])(
    'requires node execution for %s',
    (type) => {
      expect(Schema.encodeSync(eventCodec)(decodeEvent({ ...event, type }))).toEqual({ ...event, type })
      Array.forEach(['nodeId', 'executionId', 'attempt'] as const, (field) => {
        expect(() => decodeEvent({ ...event, type, [field]: undefined })).toThrow()
        expect(() => decodeEvent({ ...event, type, [field]: null })).toThrow()
      })
    },
  )

  it.each(['run.started', 'run.resumed', 'run.completed', 'run.failed'])(
    'rejects execution placeholders on %s instead of silently dropping them',
    (type) => {
      expect(() => decodeEvent({ ...event, type })).toThrow()
      expect(() => decodeEvent({ ...event, type, nodeId: null, executionId: null, attempt: null })).toThrow()
    },
  )

  it('requires position and size objects instead of flat node geometry', () => {
    const identity = {
      id: 'prepare',
      nodeId: 'prepare',
      type: 'node',
      label: 'Prepare',
      kind: 'task',
      state: 'idle',
    }
    const geometry = { position: { x: 48, y: 72 }, size: { width: 224, height: 100 } }
    const decodeShape = Schema.decodeUnknownSync(NodeShape)
    expect(decodeShape({ ...identity, ...geometry })).toEqual({ ...identity, ...geometry })
    expect(() => decodeShape({ ...identity, x: 48, y: 72, width: 224, height: 100 })).toThrow()
    expect(() => decodeShape({ ...identity, position: { x: 48 }, size: geometry.size })).toThrow()
    expect(() => decodeShape({ ...identity, position: geometry.position, size: { width: 224 } })).toThrow()
  })

  it.each([
    null,
    [],
    'state',
    1,
    undefined,
    () => 1,
    { nested: undefined },
    { nested: () => 1 },
    { nested: NaN },
    { nested: Infinity },
  ])('rejects non-object or non-JSON snapshot %j', (snapshot) => {
    expect(() => decodeRun({ ...run, snapshot })).toThrow()
    expect(() => Schema.decodeUnknownSync(RunState)({ ...state, snapshot })).toThrow()
    expect(() => decodeEvent({ ...event, payload: snapshot })).toThrow()
  })

  it('accepts recursive JSON objects for snapshots and payloads', () => {
    const snapshot = { nested: { values: [null, true, 42, 'value', { state: 'waiting' }] } }
    expect(decodeRun({ ...run, snapshot }).snapshot).toEqual(snapshot)
    expect(Schema.decodeUnknownSync(RunState)({ ...state, snapshot }).snapshot).toEqual(snapshot)
    expect(decodeEvent({ ...event, payload: snapshot }).payload).toEqual(snapshot)
  })

  it.each(unsafeIds)('rejects unsafe caller-supplied workflow ID %s', (workflowId) => {
    expect(() => decodeCreate({ workflowId, version: '1.0.0' })).toThrow()
    expect(Schema.is(Run)({ ...run, workflowId })).toBe(false)
  })

  it.each(['1.0.0', '2.13.7-rc.1+build.42', '0.0.0'])('round-trips semantic version %s', (version) => {
    expect(Schema.is(WorkflowVersion)(decodeVersion(version))).toBe(true)
    expect(SemVer.format(decodeVersion(version))).toBe(version)
    expect(Schema.encodeSync(Schema.toCodecJson(WorkflowVersion))(decodeVersion(version))).toBe(version)
    expect(SemVer.format(decodeRun({ ...run, workflowVersion: version }).workflowVersion)).toBe(version)
  })

  it.each(['v1', 'v2', '1', '1.0', '01.0.0', '1.0.0-01', '', ' 1.0.0', '1.0.0 ', '1.0.0\n'])(
    'rejects malformed version %s in creation and persisted runs',
    (version) => {
      expect(Schema.is(WorkflowVersion)(version)).toBe(false)
      expect(() => decodeVersion(version)).toThrow()
      expect(() => decodeCreate({ workflowId: 'demo', version })).toThrow()
      expect(() => decodeRun({ ...run, workflowVersion: version })).toThrow()
    },
  )

  it('preserves arbitrary workflow input without importing a workflow implementation', () => {
    const input = { workflowId: 'review', version: '3.4.5-beta.1+build.7', pullRequest: 42 }
    expect(decodeCreate(input)).toEqual({
      ...input,
      version: decodeVersion(input.version),
    })
  })

  it('round-trips strict run, state, graph and event identities', () => {
    expect(decodeRun(run)).toEqual({
      ...run,
      workflowVersion: decodeVersion(run.workflowVersion),
      createdAt: DateTime.makeUnsafe(run.createdAt),
      updatedAt: DateTime.makeUnsafe(run.updatedAt),
    })
    expect(Schema.decodeUnknownSync(RunState)(state)).toEqual(state)
    expect(decodeEvent(event)).toEqual({ ...event, createdAt: DateTime.makeUnsafe(event.createdAt) })
    expect(Schema.decodeUnknownSync(GraphDefinition)(graph)).toEqual(graph)
    expect(() => decodeEvent({ ...event, nodeId: null, executionId: null, attempt: null })).toThrow()
  })

  it.each(['demo-1_0_0-graph-1', 'jcode-development-1_0_0-graph-1', 'Graph_123'])(
    'accepts named graph ID %s',
    (graphId) => {
      expect(Schema.decodeUnknownSync(GraphDefinition)({ ...graph, graphId }).graphId).toBe(graphId)
      expect(decodeRun({ ...run, graphId }).graphId).toBe(graphId)
    },
  )

  it.each([uuid, `event_${uuid}`, `run_${uuid7}`, 'run_not-a-uuid', `run_${uuid}\n`, `run_${uuid}extra`])(
    'rejects invalid run ID %s across run, state and event boundaries',
    (runId) => {
      expect(() => decodeRun({ ...run, runId })).toThrow()
      expect(() => Schema.decodeUnknownSync(RunState)({ ...state, runId })).toThrow()
      expect(() => decodeEvent({ ...event, runId })).toThrow()
    },
  )

  it.each(['eventId', 'executionId'] as const)('enforces the %s UUIDv4 prefix', (field) => {
    const prefix = field === 'eventId' ? 'event' : 'execution'
    Array.forEach([uuid, `run_${uuid}`, `${prefix}_${uuid7}`, `${prefix}_bad`, `${prefix}_${uuid}\n`], (id) => {
      expect(() => decodeEvent({ ...event, [field]: id })).toThrow()
    })
  })

  it.each(unsafeIds)('rejects invalid named identity %s in every graph position', (id) => {
    expect(() => decodeRun({ ...run, graphId: id })).toThrow()
    expect(() => Schema.decodeUnknownSync(GraphDefinition)({ ...graph, graphId: id })).toThrow()
    expect(() => decodeEvent({ ...event, nodeId: id })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(GraphDefinition)({ ...graph, nodes: [{ ...graph.nodes[0], nodeId: id }] }),
    ).toThrow()
    Array.forEach(['edgeId', 'source', 'target'] as const, (field) => {
      expect(() =>
        Schema.decodeUnknownSync(GraphDefinition)({ ...graph, edges: [{ ...graph.edges[0], [field]: id }] }),
      ).toThrow()
    })
  })
})
