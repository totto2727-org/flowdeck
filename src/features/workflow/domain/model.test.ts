import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CreateRun, Run, WorkflowVersion } from './model'

const decodeVersion = Schema.decodeUnknownSync(WorkflowVersion)

describe('workflow-neutral wire schemas', () => {
  it.each(['../demo', 'demo/workflow', 'two words', 'ワークフロー'])(
    'rejects unsafe caller-supplied workflow ID %s',
    (workflowId) => {
      expect(() => Schema.decodeUnknownSync(CreateRun)({ workflowId, version: '1.0.0' })).toThrow()
    },
  )

  it.each(['1.0.0', '2.13.7-rc.1+build.42', '0.0.0'])('round-trips semantic version %s', (version) => {
    expect(Schema.is(WorkflowVersion)(version)).toBe(true)
    expect(decodeVersion(version)).toBe(version)
    expect(Schema.encodeSync(WorkflowVersion)(version)).toBe(version)
  })

  it.each(['v1', '1', '1.0', '01.0.0', '1.0.0-01', '', ' 1.0.0', '1.0.0 ', '1.0.0\n'])(
    'rejects malformed new version %s',
    (version) => {
      expect(Schema.is(WorkflowVersion)(version)).toBe(false)
      expect(() => decodeVersion(version)).toThrow()
      expect(() => Schema.encodeSync(WorkflowVersion)(version)).toThrow()
    },
  )

  it('preserves arbitrary workflow input without importing a workflow implementation', () => {
    const input = { workflowId: 'review', version: '3.4.5-beta.1+build.7', pullRequest: 42 }
    expect(Schema.decodeUnknownSync(CreateRun)(input)).toEqual(input)
  })

  it('keeps legacy persisted version strings readable', () => {
    const run = {
      runId: '00000000-0000-4000-8000-000000000003',
      workflowId: 'retired-workflow',
      workflowVersion: 'v1',
      graphId: 'persisted-graph',
      status: 'waiting',
      revision: 1,
      snapshot: {},
      createdAt: '2026-10-24T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z',
    }
    expect(Schema.decodeUnknownSync(Run)(run)).toEqual(run)
    expect(Schema.decodeUnknownSync(Run)({ ...run, runId: 'run_' + run.runId }).runId).toBe('run_' + run.runId)
    for (const runId of ['not-a-run-id', 'event_' + run.runId, 'run_01890f2e-7b55-7cc1-8c5a-000000000001']) {
      expect(Schema.is(Run)({ ...run, runId })).toBe(false)
      expect(() => Schema.decodeUnknownSync(Run)({ ...run, runId })).toThrow()
    }
    for (const workflowId of ['', '../demo', 'two words', 'ワークフロー']) {
      expect(Schema.is(Run)({ ...run, workflowId })).toBe(false)
      expect(() => Schema.decodeUnknownSync(Run)({ ...run, workflowId })).toThrow()
    }
  })
})
