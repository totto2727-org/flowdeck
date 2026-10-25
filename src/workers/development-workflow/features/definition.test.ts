import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type { Run } from '../../../features/workflow/domain/model'
import { developmentDefinition } from './definition'
import { restoreDevelopment } from './development'

const input = {
  workflowId: 'jcode-development',
  version: '1.0.0',
  repository: 'https://github.com/example/project',
  task: 'Implement the requested change.',
}

describe('development legacy restore boundary', () => {
  const run: Run = {
    runId: 'legacy-run',
    workflowId: 'jcode-development',
    workflowVersion: 'v1',
    graphId: 'jcode-development:v1:graph:1',
    status: 'running',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    snapshot: null,
  }
  const completing = {
    _tag: 'Completing',
    schemaVersion: 1,
    version: 'v1',
    repository: input.repository,
    task: input.task,
    sessionId: '1',
    result: 'done',
  }

  it('restores omitted legacy fields into explicit required fields', async () => {
    expect(await Effect.runPromise(restoreDevelopment({ ...run, snapshot: completing }))).toEqual({
      ...completing,
      runtime: 'legacy-missing',
      commandId: 'legacy-run:verify:1',
    })
  })

  it.each(['pi', 'pi-harness'])(
    'preserves explicit runtime %s while migrating the completing identity',
    async (runtime) => {
      expect(await Effect.runPromise(restoreDevelopment({ ...run, snapshot: { ...completing, runtime } }))).toEqual({
        ...completing,
        runtime,
        commandId: 'legacy-run:verify:1',
      })
    },
  )

  it('rejects an invalid explicit runtime instead of treating it as missing', async () => {
    await expect(
      Effect.runPromise(restoreDevelopment({ ...run, snapshot: { ...completing, runtime: null } })),
    ).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
  })
})

describe('development definition', () => {
  it('prepares the workflow-owned graph and PiHarness snapshot', async () => {
    expect(await Effect.runPromise(developmentDefinition.prepare(input))).toEqual({
      graph: {
        graphId: 'jcode-development:1.0.0:graph:1',
        schemaVersion: 1,
        nodes: [
          { nodeId: 'implement', label: 'Implement task', kind: 'task' },
          { nodeId: 'verify', label: 'Verify and fix', kind: 'task' },
        ],
        edges: [
          { edgeId: 'implement-verify', source: 'implement', target: 'verify', label: 'implementation complete' },
        ],
      },
      snapshot: {
        _tag: 'Ready',
        schemaVersion: 1,
        version: '1.0.0',
        runtime: 'pi-harness',
        repository: input.repository,
        task: input.task,
      },
    })
  })

  it.each(['https://github.com/example/project', 'https://github.com/example/project.git'])(
    'preserves the validated URL string %s',
    async (repository) => {
      const prepared = await Effect.runPromise(developmentDefinition.prepare({ ...input, repository }))
      expect(prepared.snapshot).toMatchObject({ repository })
    },
  )

  it.each([
    'https://github.com:8443/example/project',
    'https://github.com/example/%70roject',
    'http://github.com/example/project',
    'https://example.com/example/project',
    'https://user:password@github.com/example/project',
    'https://github.com/example/project?token=secret',
    'https://github.com/example/project#fragment',
    'https://github.com/example/project/tree/main',
    'https://github.com/example/other/../project',
    'https://github.com/exam\nple/project',
    'https://github.com/example/project?',
    'not a URL',
  ])('rejects unsafe repository %s', async (repository) => {
    await expect(Effect.runPromise(developmentDefinition.prepare({ ...input, repository }))).rejects.toThrow()
  })

  it.each([
    { ...input, version: 'v1' },
    { ...input, version: '2.0.0' },
    { ...input, task: '' },
    { ...input, task: '   ' },
    { ...input, task: 'x'.repeat(16_001) },
    { ...input, extra: true },
  ])('rejects invalid local input', async (invalid) => {
    await expect(Effect.runPromise(developmentDefinition.prepare(invalid))).rejects.toThrow()
  })
})
