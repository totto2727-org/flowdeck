import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CreateRun, Run, SemanticVersion } from './model'

const decodeVersion = Schema.decodeUnknownSync(SemanticVersion)

describe('workflow-neutral wire schemas', () => {
  it.each(['1.0.0', '2.13.7-rc.1+build.42', '0.0.0'])('accepts semantic version %s', (version) => {
    expect(decodeVersion(version)).toBe(version)
  })

  it.each(['v1', '1', '1.0', '01.0.0', '1.0.0-01', ''])('rejects malformed new version %s', (version) => {
    expect(() => decodeVersion(version)).toThrow()
  })

  it('preserves arbitrary workflow input without importing a workflow implementation', () => {
    const input = { workflowId: 'review', version: '3.4.5-beta.1+build.7', pullRequest: 42 }
    expect(Schema.decodeUnknownSync(CreateRun)(input)).toEqual(input)
  })

  it('keeps legacy persisted version strings readable', () => {
    const run = {
      runId: 'persisted-run',
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
  })
})
