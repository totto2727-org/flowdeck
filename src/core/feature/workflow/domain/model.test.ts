import { Array, DateTime, Result, Schema, SemVer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { CreateRun, GraphDefinition, NodeShape, Run, RunEvent, RunState, WorkflowVersion } from './model.ts'

const decodeNodeShape = Schema.decodeUnknownResult(NodeShape)
const decodeRunState = Schema.decodeUnknownResult(RunState)
const decodeGraphDefinition = Schema.decodeUnknownResult(GraphDefinition)

// oxlint-disable-next-line unicorn/no-null -- This is the explicit JSON null tested separately from omitted fields.
const wireNull = null

const uuid = '00000000-0000-4000-8000-000000000003'
const uuid7 = '01890f2e-7b55-7cc1-8c5a-000000000001'
const run = {
  createdAt: '2026-10-24T00:00:00.000Z',
  graphId: 'demo-1_0_0-graph-1',
  revision: 1,
  runId: `run_${uuid}`,
  snapshot: {},
  status: 'waiting',
  updatedAt: '2026-10-24T00:00:00.000Z',
  workflowId: 'demo',
  workflowVersion: '1.0.0',
} as const
const state = { revision: 1, runId: run.runId, snapshot: {} }
const event = {
  attempt: 1,
  createdAt: run.createdAt,
  eventId: `event_${uuid}`,
  executionId: `execution_${uuid}`,
  nodeId: 'prepare',
  payload: {},
  runId: run.runId,
  sequence: 1,
  type: 'node.started',
} as const
const graph = {
  edges: [{ edgeId: 'prepare-approval', label: 'Ready', source: 'prepare', target: 'approval' }],
  graphId: run.graphId,
  nodes: [{ kind: 'task', label: 'Prepare', nodeId: 'prepare' }],
  schemaVersion: 1,
} as const
const unsafeIds = ['', '../demo', 'demo/workflow', 'two words', 'ワークフロー', 'demo:graph', 'demo.graph', 'node\n']
const runCodec = Schema.toCodecJson(Run)
const eventCodec = Schema.toCodecJson(RunEvent)
const createCodec = Schema.toCodecJson(CreateRun)
const decodeRun = Schema.decodeUnknownResult(runCodec)
const decodeEvent = Schema.decodeUnknownResult(eventCodec, { onExcessProperty: 'error' })
const decodeCreate = Schema.decodeUnknownResult(createCodec)
const versionCodec = Schema.toCodecJson(WorkflowVersion)
const decodeVersion = Schema.decodeUnknownResult(versionCodec)
const encodeRun = Schema.encodeResult(runCodec)
const encodeEvent = Schema.encodeResult(eventCodec)
const encodeCreate = Schema.encodeResult(createCodec)
const encodeVersion = Schema.encodeResult(versionCodec)

describe('workflow-neutral wire schemas', () => {
  test('keeps rich domain versions and UTC timestamps separate from JSON', () => {
    const domain = Result.getOrThrow(decodeRun(run))
    expect(Schema.is(Run)(domain)).toBe(true)
    expect(Schema.is(Run)(run)).toBe(false)
    expect(DateTime.isUtc(domain.createdAt)).toBe(true)
    expect(DateTime.isUtc(domain.updatedAt)).toBe(true)
    expect(Result.getOrThrow(encodeRun(domain))).toStrictEqual(run)
  })

  test('round-trips the normalized event and creation payload', () => {
    const domainEvent = Result.getOrThrow(decodeEvent(event))
    expect(Result.getOrThrow(encodeEvent(domainEvent))).toStrictEqual(event)
    const input = { title: 'Release', version: '1.0.0', workflowId: 'demo' }
    const domainInput = Result.getOrThrow(decodeCreate(input))
    expect(Result.getOrThrow(encodeCreate(domainInput))).toStrictEqual(input)
  })

  test.each(['createdAt', 'updatedAt'] as const)('rejects invalid run timestamp %s', (field) => {
    expect(Result.isFailure(decodeRun({ ...run, [field]: 'not-a-date' }))).toBe(true)
    expect(Result.isFailure(decodeRun({ ...run, [field]: wireNull }))).toBe(true)
    expect(Result.isFailure(decodeEvent({ ...event, createdAt: 'not-a-date' }))).toBe(true)
  })
})

describe('workflow event wire contracts', () => {
  test.each(['run.started', 'run.resumed', 'run.completed', 'run.failed'])(
    'decodes %s without node identity',
    (type) => {
      const input = {
        createdAt: event.createdAt,
        eventId: event.eventId,
        payload: {},
        runId: event.runId,
        sequence: 1,
        type,
      }
      const decoded = Result.getOrThrow(decodeEvent(input))
      expect('nodeId' in decoded).toBe(false)
      expect('executionId' in decoded).toBe(false)
      expect('attempt' in decoded).toBe(false)
      expect(Result.getOrThrow(encodeEvent(decoded))).toStrictEqual(input)
    },
  )

  test.each(['node.started', 'node.succeeded', 'node.failed', 'run.waiting'])(
    'requires node execution for %s',
    (type) => {
      expect.hasAssertions()
      const input = { ...event, type }
      const decoded = Result.getOrThrow(decodeEvent(input))
      expect(Result.getOrThrow(encodeEvent(decoded))).toStrictEqual(input)
      Array.forEach(['nodeId', 'executionId', 'attempt'] as const, (field) => {
        expect(Result.isFailure(decodeEvent({ ...input, [field]: undefined }))).toBe(true)
        expect(Result.isFailure(decodeEvent({ ...input, [field]: wireNull }))).toBe(true)
      })
    },
  )

  test.each(['run.started', 'run.resumed', 'run.completed', 'run.failed'])(
    'rejects execution placeholders on %s instead of silently dropping them',
    (type) => {
      expect(Result.isFailure(decodeEvent({ ...event, type }))).toBe(true)
      expect(
        Result.isFailure(decodeEvent({ ...event, attempt: wireNull, executionId: wireNull, nodeId: wireNull, type })),
      ).toBe(true)
    },
  )
})

describe('workflow geometry and JSON contracts', () => {
  test('requires position and size objects instead of flat node geometry', () => {
    const identity = {
      id: 'prepare',
      kind: 'task',
      label: 'Prepare',
      nodeId: 'prepare',
      state: 'idle',
      type: 'node',
    }
    const geometry = { position: { x: 48, y: 72 }, size: { height: 100, width: 224 } }
    const decodeShape = decodeNodeShape
    expect(Result.getOrThrow(decodeShape({ ...identity, ...geometry }))).toStrictEqual({ ...identity, ...geometry })
    expect(Result.isFailure(decodeShape({ ...identity, height: 100, width: 224, x: 48, y: 72 }))).toBe(true)
    expect(Result.isFailure(decodeShape({ ...identity, position: { x: 48 }, size: geometry.size }))).toBe(true)
    expect(Result.isFailure(decodeShape({ ...identity, position: geometry.position, size: { width: 224 } }))).toBe(true)
  })

  test.each([
    wireNull,
    [],
    'state',
    1,
    undefined,
    () => 1,
    { nested: undefined },
    { nested: () => 1 },
    { nested: Number.NaN },
    { nested: Infinity },
  ])('rejects non-object or non-JSON snapshot %j', (snapshot) => {
    expect(Result.isFailure(decodeRun({ ...run, snapshot }))).toBe(true)
    expect(Result.isFailure(decodeRunState({ ...state, snapshot }))).toBe(true)
    expect(Result.isFailure(decodeEvent({ ...event, payload: snapshot }))).toBe(true)
  })

  test('accepts recursive JSON objects for snapshots and payloads', () => {
    const snapshot = { nested: { values: [wireNull, true, 42, 'value', { state: 'waiting' }] } }
    expect(Result.getOrThrow(decodeRun({ ...run, snapshot })).snapshot).toStrictEqual(snapshot)
    expect(Result.getOrThrow(decodeRunState({ ...state, snapshot })).snapshot).toStrictEqual(snapshot)
    expect(Result.getOrThrow(decodeEvent({ ...event, payload: snapshot })).payload).toStrictEqual(snapshot)
  })
})

describe('workflow routing and SemVer wire contracts', () => {
  test.each(unsafeIds)('rejects unsafe caller-supplied workflow ID %s', (workflowId) => {
    expect(Result.isFailure(decodeCreate({ version: '1.0.0', workflowId }))).toBe(true)
    expect(Schema.is(Run)({ ...run, workflowId })).toBe(false)
  })

  test.each(['1.0.0', '2.13.7-rc.1+build.42', '0.0.0'])('round-trips semantic version %s', (version) => {
    const decoded = Result.getOrThrow(decodeVersion(version))
    const persisted = Result.getOrThrow(decodeRun({ ...run, workflowVersion: version }))
    expect(Schema.is(WorkflowVersion)(decoded)).toBe(true)
    expect(SemVer.format(decoded)).toBe(version)
    expect(Result.getOrThrow(encodeVersion(decoded))).toBe(version)
    expect(SemVer.format(persisted.workflowVersion)).toBe(version)
  })

  test.each(['v1', 'v2', '1', '1.0', '01.0.0', '1.0.0-01', '', ' 1.0.0', '1.0.0 ', '1.0.0\n'])(
    'rejects malformed version %s in creation and persisted runs',
    (version) => {
      expect(Schema.is(WorkflowVersion)(version)).toBe(false)
      expect(Result.isFailure(decodeVersion(version))).toBe(true)
      expect(Result.isFailure(decodeCreate({ version, workflowId: 'demo' }))).toBe(true)
      expect(Result.isFailure(decodeRun({ ...run, workflowVersion: version }))).toBe(true)
    },
  )

  test('preserves arbitrary workflow input without importing a workflow implementation', () => {
    const input = { pullRequest: 42, version: '3.4.5-beta.1+build.7', workflowId: 'review' }
    expect(Result.getOrThrow(decodeCreate(input))).toStrictEqual({
      ...input,
      version: Result.getOrThrow(decodeVersion(input.version)),
    })
  })
})

describe('run and graph identity contracts', () => {
  test('round-trips strict run, state, graph and event identities', () => {
    expect(Result.getOrThrow(decodeRun(run))).toStrictEqual({
      ...run,
      createdAt: DateTime.makeUnsafe(run.createdAt),
      updatedAt: DateTime.makeUnsafe(run.updatedAt),
      workflowVersion: Result.getOrThrow(decodeVersion(run.workflowVersion)),
    })
    expect(Result.getOrThrow(decodeRunState(state))).toStrictEqual(state)
    expect(Result.getOrThrow(decodeEvent(event))).toStrictEqual({
      ...event,
      createdAt: DateTime.makeUnsafe(event.createdAt),
    })
    expect(Result.getOrThrow(decodeGraphDefinition(graph))).toStrictEqual(graph)
    expect(
      Result.isFailure(decodeEvent({ ...event, attempt: wireNull, executionId: wireNull, nodeId: wireNull })),
    ).toBe(true)
  })

  test.each(['demo-1_0_0-graph-1', 'jcode-development-1_0_0-graph-1', 'Graph_123'])(
    'accepts named graph ID %s',
    (graphId) => {
      expect(Result.getOrThrow(decodeGraphDefinition({ ...graph, graphId })).graphId).toBe(graphId)
      expect(Result.getOrThrow(decodeRun({ ...run, graphId })).graphId).toBe(graphId)
    },
  )

  test.each([uuid, `event_${uuid}`, `run_${uuid7}`, 'run_not-a-uuid', `run_${uuid}\n`, `run_${uuid}extra`])(
    'rejects invalid run ID %s across run, state and event boundaries',
    (runId) => {
      expect(Result.isFailure(decodeRun({ ...run, runId }))).toBe(true)
      expect(Result.isFailure(decodeRunState({ ...state, runId }))).toBe(true)
      expect(Result.isFailure(decodeEvent({ ...event, runId }))).toBe(true)
    },
  )
})

describe('execution and graph member identity contracts', () => {
  test.each([
    { field: 'eventId', prefix: 'event' },
    { field: 'executionId', prefix: 'execution' },
  ] as const)('enforces the $field UUIDv4 prefix', ({ field, prefix }) => {
    expect.hasAssertions()
    Array.forEach([uuid, `run_${uuid}`, `${prefix}_${uuid7}`, `${prefix}_bad`, `${prefix}_${uuid}\n`], (id) => {
      expect(Result.isFailure(decodeEvent({ ...event, [field]: id }))).toBe(true)
    })
  })

  test.each(unsafeIds)('rejects invalid named identity %s in every graph position', (id) => {
    expect.hasAssertions()
    expect(Result.isFailure(decodeRun({ ...run, graphId: id }))).toBe(true)
    expect(Result.isFailure(decodeGraphDefinition({ ...graph, graphId: id }))).toBe(true)
    expect(Result.isFailure(decodeEvent({ ...event, nodeId: id }))).toBe(true)
    expect(Result.isFailure(decodeGraphDefinition({ ...graph, nodes: [{ ...graph.nodes[0], nodeId: id }] }))).toBe(true)
    Array.forEach(['edgeId', 'source', 'target'] as const, (field) => {
      expect(Result.isFailure(decodeGraphDefinition({ ...graph, edges: [{ ...graph.edges[0], [field]: id }] }))).toBe(
        true,
      )
    })
  })
})
