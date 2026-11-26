import { live } from '@effect/vitest'
import { DateTime, Effect, Schema } from 'effect'
import { expect } from 'vite-plus/test'

import { RpcCreateRun, RpcRunDetail, RpcWorkflowsResponse } from '@/core/feature/workflow/rpc/contract'

import { runId } from './control-api.fixture.ts'

const decodeVersion = Schema.decodeEffect(Schema.SemVerFromString)
const decodeCreateRun = Schema.decodeEffect(RpcCreateRun)
const decodeRunDetail = Schema.decodeEffect(RpcRunDetail, { onExcessProperty: 'error' })
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The malformed peer reply intentionally violates the wire schema.
const decodeUnknownRunDetail = Schema.decodeUnknownEffect(RpcRunDetail, { onExcessProperty: 'error' })
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The encoded JSON representation is only known to be a Json value.
const decodeJsonObject = Schema.decodeUnknownEffect(Schema.JsonObject)
const decodeWorkflows = Schema.decodeEffect(RpcWorkflowsResponse)
const encodeCreateRun = Schema.encodeEffect(RpcCreateRun)
const encodeRunDetail = Schema.encodeEffect(RpcRunDetail)
const encodeWorkflows = Schema.encodeEffect(RpcWorkflowsResponse)

const iso = '2026-10-31T00:00:00.000Z'
const timestamp = DateTime.makeUnsafe(iso)
const graphId = 'graph-1'
const workflowId = 'demo'
// oxlint-disable-next-line unicorn/no-null -- Null is a valid nested JSON value and an invalid run-event node ID.
const wireNull = null
const snapshot = { nested: { valid: [true, wireNull, 1] } }
const revision = 1
const details = Effect.gen(function* () {
  const workflowVersion = yield* decodeVersion('1.0.0')
  return {
    events: [
      {
        createdAt: timestamp,
        eventId: 'event_00000000-0000-4000-8000-000000000001',
        payload: {},
        runId,
        sequence: 1,
        type: 'run.started',
      },
      {
        attempt: 1,
        createdAt: timestamp,
        eventId: 'event_00000000-0000-4000-8000-000000000002',
        executionId: 'execution_00000000-0000-4000-8000-000000000001',
        nodeId: 'prepare',
        payload: {},
        runId,
        sequence: 2,
        type: 'node.started',
      },
    ],
    graph: { edges: [], graphId, nodes: [], schemaVersion: 1 },
    run: {
      createdAt: timestamp,
      graphId,
      revision,
      runId,
      snapshot,
      status: 'running',
      updatedAt: timestamp,
      workflowId,
      workflowVersion,
    },
    shapes: { edges: [], nodes: [] },
    state: { revision, runId, snapshot },
  } as const
})

live('encodes timestamp and event variants for RPC without losing domain values', () =>
  Effect.gen(function* () {
    const detail = yield* details
    const encoded = yield* encodeRunDetail(detail)
    expect(encoded).toMatchObject({
      events: [
        { createdAt: iso, type: 'run.started' },
        { attempt: 1, nodeId: 'prepare', type: 'node.started' },
      ],
      run: { createdAt: iso, updatedAt: iso, workflowVersion: '1.0.0' },
    })
    expect(yield* decodeRunDetail(structuredClone(encoded))).toStrictEqual(detail)
  }),
)

live('rejects an unexpected node ID in a run event', () =>
  Effect.gen(function* () {
    const detail = yield* details
    const encoded = yield* encodeRunDetail(detail)
    const wire = yield* decodeJsonObject(encoded)
    const first = { ...detail.events[0], createdAt: iso, nodeId: wireNull }
    const malformed = { ...wire, events: [first] }
    expect(yield* Effect.flip(decodeUnknownRunDetail(malformed))).toBeInstanceOf(Schema.SchemaError)
  }),
)

live('round trips create input SemVer through native RPC-compatible values', () =>
  Effect.gen(function* () {
    const version = yield* decodeVersion('1.2.3')
    const input = { version, workflowId }
    const encoded = yield* encodeCreateRun(input)
    expect(encoded).toStrictEqual({ version: '1.2.3', workflowId })
    expect(yield* decodeCreateRun(structuredClone(encoded))).toStrictEqual(input)
  }),
)

live('round trips catalog SemVer through native RPC-compatible values', () =>
  Effect.gen(function* () {
    const version = yield* decodeVersion('1.2.3')
    const catalog = { workflows: [{ inputs: [], name: 'Demo', versions: [version], workflowId }] }
    const encoded = yield* encodeWorkflows(catalog)
    expect(encoded).toStrictEqual({ workflows: [{ inputs: [], name: 'Demo', versions: ['1.2.3'], workflowId }] })
    expect(yield* decodeWorkflows(structuredClone(encoded))).toStrictEqual(catalog)
  }),
)
