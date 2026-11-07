import { DateTime, Schema, SemVer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  Run as DomainRun,
  RunDetail as DomainRunDetail,
  WorkflowSummary as DomainWorkflowSummary,
} from '../../../features/workflow/domain/model'
import { presentDetail, presentRun, presentWorkflow } from './view-model'

const runJson = {
  runId: 'run_00000000-0000-4000-8000-000000000001',
  workflowId: 'demo',
  workflowVersion: '2.13.7-rc.1+build.42',
  graphId: 'demo-2_13_7-graph-1',
  status: 'waiting',
  revision: 1,
  snapshot: {},
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
}

describe('frontend view boundary', () => {
  it('presents official JSON versions without changing domain values', () => {
    const run = Schema.decodeUnknownSync(Schema.toCodecJson(DomainRun))(runJson)
    expect(presentRun(run)).toEqual(runJson)
    expect(SemVer.isSemVer(run.workflowVersion)).toBe(true)
    expect(DateTime.isUtc(run.createdAt)).toBe(true)
    expect(DateTime.isUtc(run.updatedAt)).toBe(true)
    expect(Schema.is(DomainRun)(runJson)).toBe(false)
  })

  it('presents all catalog versions as DOM option strings', () => {
    const json = { workflowId: 'demo', name: 'Demo', versions: ['1.0.0', '2.13.7-rc.1+build.42'], inputs: [] }
    const workflow = Schema.decodeUnknownSync(Schema.toCodecJson(DomainWorkflowSummary))(json)
    expect(presentWorkflow(workflow)).toEqual(json)
    expect(SemVer.isSemVer(workflow.versions[0])).toBe(true)
  })

  it('presents selected details using the same representation as list entries', () => {
    const json = {
      run: runJson,
      state: { runId: runJson.runId, revision: 1, snapshot: {} },
      graph: { graphId: runJson.graphId, schemaVersion: 1, nodes: [], edges: [] },
      events: [
        {
          eventId: 'event_00000000-0000-4000-8000-000000000001',
          runId: runJson.runId,
          sequence: 1,
          type: 'run.started',
          payload: {},
          createdAt: runJson.createdAt,
        },
        {
          eventId: 'event_00000000-0000-4000-8000-000000000002',
          runId: runJson.runId,
          sequence: 2,
          type: 'run.waiting',
          nodeId: 'approval',
          executionId: 'execution_00000000-0000-4000-8000-000000000001',
          attempt: 1,
          payload: {},
          createdAt: runJson.createdAt,
        },
      ],
      shapes: {
        nodes: [
          {
            id: 'approval',
            nodeId: 'approval',
            type: 'node',
            label: 'Approval',
            kind: 'checkpoint',
            position: { x: 40, y: 80 },
            size: { width: 180, height: 90 },
            state: 'waiting',
          },
        ],
        edges: [],
      },
    }
    const detail = Schema.decodeUnknownSync(Schema.toCodecJson(DomainRunDetail))(json)
    expect(presentDetail(detail)).toEqual(json)
    expect(presentDetail(detail).run).toEqual(presentRun(detail.run))
    expect(SemVer.isSemVer(detail.run.workflowVersion)).toBe(true)
  })
})
