import { Machine } from '@typeonce/effect-machine'
import { DateTime, Effect, Option, Schema, SemVer, String } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { JsonObject, type Run } from '@/features/workflow/domain/model'

import { developmentDefinition } from './definition'
import { restoreDevelopment } from './development'
import { DevelopmentMachine, DevelopmentStates } from './development-machine'
import { DevelopmentCreateRun } from './input'
import { developmentVersion } from './input'

const input = {
  workflowId: 'jcode-development',
  version: developmentVersion,
  repository: 'https://github.com/example/project',
  task: 'Implement the requested change.',
}

describe('development strict restore boundary', () => {
  const run: Run = {
    runId: 'run_00000000-0000-4000-8000-000000000002',
    workflowId: 'jcode-development',
    workflowVersion: developmentVersion,
    graphId: 'jcode-development-1_0_0-graph-1',
    status: 'running',
    revision: 1,
    createdAt: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
    updatedAt: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
    snapshot: {},
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

  it.each(['"runtime":"pi"', '"runtime":null', '"runtime":false', '"other":"pi-harness"'])(
    'rejects malformed native runtime %s before accessing Pi',
    async (runtime) => {
      const prepared = await Effect.runPromise(developmentDefinition.prepare(input))
      const snapshot = Schema.decodeUnknownSync(JsonObject)(
        JSON.parse(String.replace('"runtime":"pi-harness"', runtime)(JSON.stringify(prepared.snapshot))),
      )
      await expect(
        Effect.runPromise(restoreDevelopment({ ...run, status: 'pending', snapshot })),
      ).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
    },
  )

  it('rejects omitted runtime and command identities instead of restoring them', async () => {
    await expect(Effect.runPromise(restoreDevelopment({ ...run, snapshot: completing }))).rejects.toMatchObject({
      _tag: 'InvalidSnapshot',
    })
  })

  it.each(['pi', 'pi-harness'])('rejects runtime %s with missing command identity', async (runtime) => {
    await expect(
      Effect.runPromise(restoreDevelopment({ ...run, snapshot: { ...completing, runtime } })),
    ).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
  })

  it('rejects an invalid explicit runtime instead of treating it as missing', async () => {
    await expect(
      Effect.runPromise(restoreDevelopment({ ...run, snapshot: { ...completing, runtime: null } })),
    ).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
  })
})

describe('development definition', () => {
  it('prepares the workflow-owned graph and PiHarness snapshot', async () => {
    expect(await Effect.runPromise(developmentDefinition.prepare(input))).toMatchObject({
      graph: {
        graphId: 'jcode-development-1_0_0-graph-1',
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
        schemaVersion: 1,
        version: '1.0.0',
        machine: { _tag: 'MachineSnapshot', version: 2 },
      },
    })
  })

  it.each(['https://github.com/example/project', 'https://github.com/example/project.git'])(
    'preserves the validated URL string %s',
    async (repository) => {
      const prepared = await Effect.runPromise(developmentDefinition.prepare({ ...input, repository }))
      const state = await Effect.runPromise(Machine.decodeSnapshot(DevelopmentMachine, prepared.snapshot['machine']))
      expect(Option.getOrThrow(DevelopmentStates.get(state, '')).repository.href).toBe(repository)
      expect(DevelopmentStates.matches(state, 'implement.allocate')).toBe(true)
      expect(prepared.snapshot).not.toHaveProperty('context')
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
    'https://github.com/example/project?',
    'not a URL',
  ])('rejects unsafe repository %s', async (repository) => {
    await expect(Effect.runPromise(developmentDefinition.prepare({ ...input, repository }))).rejects.toThrow()
  })

  it('rejects a string version at the domain boundary', () => {
    expect(() => Schema.decodeUnknownSync(DevelopmentCreateRun)({ ...input, version: '1.0.0' })).toThrow()
  })

  it.each([
    { ...input, version: SemVer.make({ major: 2, minor: 0, patch: 0 }) },
    { ...input, task: '' },
    { ...input, task: '   ' },
    { ...input, task: 'x'.repeat(16_001) },
    { ...input, extra: true },
  ])('rejects invalid local input', async (invalid) => {
    await expect(Effect.runPromise(developmentDefinition.prepare(invalid))).rejects.toThrow()
  })
})
