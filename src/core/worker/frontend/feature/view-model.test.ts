import { DateTime, Result, Schema, SemVer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import {
  Run as DomainRun,
  RunDetail as DomainRunDetail,
  WorkflowSummary as DomainWorkflowSummary,
} from '@/core/feature/workflow/domain/model'

import { presentDetail, presentRun, presentWorkflow } from './view-model.ts'

const decodeRun = Schema.decodeResult(Schema.toCodecJson(DomainRun))
const decodeWorkflowSummary = Schema.decodeResult(Schema.toCodecJson(DomainWorkflowSummary))
const decodeRunDetail = Schema.decodeResult(Schema.toCodecJson(DomainRunDetail))

const runJson = {
  createdAt: '2026-10-31T00:00:00.000Z',
  graphId: 'demo-2_13_7-graph-1',
  revision: 1,
  runId: 'run_00000000-0000-4000-8000-000000000001',
  snapshot: {},
  status: 'waiting',
  updatedAt: '2026-10-31T00:00:00.000Z',
  workflowId: 'demo',
  workflowVersion: '2.13.7-rc.1+build.42',
} as const

const detailJson = {
  events: [
    {
      createdAt: runJson.createdAt,
      eventId: 'event_00000000-0000-4000-8000-000000000001',
      payload: {},
      runId: runJson.runId,
      sequence: 1,
      type: 'run.started',
    },
    {
      attempt: 1,
      createdAt: runJson.createdAt,
      eventId: 'event_00000000-0000-4000-8000-000000000002',
      executionId: 'execution_00000000-0000-4000-8000-000000000001',
      nodeId: 'approval',
      payload: {},
      runId: runJson.runId,
      sequence: 2,
      type: 'run.waiting',
    },
  ],
  graph: { edges: [], graphId: runJson.graphId, nodes: [], schemaVersion: 1 },
  run: runJson,
  shapes: {
    edges: [],
    nodes: [
      {
        id: 'approval',
        kind: 'checkpoint',
        label: 'Approval',
        nodeId: 'approval',
        position: { x: 40, y: 80 },
        size: { height: 90, width: 180 },
        state: 'waiting',
        type: 'node',
      },
    ],
  },
  state: { revision: 1, runId: runJson.runId, snapshot: {} },
} as const

describe('frontend view boundary', () => {
  test('presents official JSON versions without changing domain values', () => {
    const run = Result.getOrThrow(decodeRun(runJson))
    expect(presentRun(run)).toStrictEqual(runJson)
    expect(SemVer.isSemVer(run.workflowVersion)).toBe(true)
    expect(DateTime.isUtc(run.createdAt)).toBe(true)
    expect(DateTime.isUtc(run.updatedAt)).toBe(true)
    expect(Schema.is(DomainRun)(runJson)).toBe(false)
  })

  test('presents all catalog versions as DOM option strings', () => {
    const json = { inputs: [], name: 'Demo', versions: ['1.0.0', '2.13.7-rc.1+build.42'], workflowId: 'demo' }
    const workflow = Result.getOrThrow(decodeWorkflowSummary(json))
    expect(presentWorkflow(workflow)).toStrictEqual(json)
    expect(SemVer.isSemVer(workflow.versions[0])).toBe(true)
  })

  test('presents selected details using the same representation as list entries', () => {
    const detail = Result.getOrThrow(decodeRunDetail(detailJson))
    expect(presentDetail(detail)).toStrictEqual(detailJson)
    expect(presentDetail(detail).run).toStrictEqual(presentRun(detail.run))
    expect(SemVer.isSemVer(detail.run.workflowVersion)).toBe(true)
  })
})
