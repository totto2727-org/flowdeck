import { DateTime, Effect, Schema, SemVer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { GraphDefinition, type Run } from '@/features/workflow/domain/model'

import { demoDefinition } from './definition'
import { demoGraph, DemoSnapshot, encodeDemoSnapshot, initialSnapshot, restoreDemo } from './demo'
import { DemoCreateRun, demoVersion1, demoVersion2 } from './input'
import { DemoData } from './node'

const snapshotCodec = Schema.toCodecJson(DemoSnapshot)
const fixture = (version: typeof demoVersion1): Run => ({
  runId: 'run_00000000-0000-4000-8000-000000000001',
  workflowId: 'demo',
  workflowVersion: version,
  graphId: demoGraph(version).graphId,
  status: 'pending',
  revision: 0,
  snapshot: Effect.runSync(encodeDemoSnapshot(initialSnapshot(version))),
  createdAt: DateTime.makeUnsafe('2026-10-31T00:00:00.000Z'),
  updatedAt: DateTime.makeUnsafe('2026-10-31T00:00:00.000Z'),
})

describe('demo definition', () => {
  it.each([demoVersion1, demoVersion2])('keeps the published definition %s stable', async (version) => {
    const prepared = await Effect.runPromise(demoDefinition.prepare({ workflowId: 'demo', version }))
    expect(prepared).toMatchSnapshot(`demo ${SemVer.format(version)}`)
  })
  it.each([demoVersion1, demoVersion2])(
    'prepares and restores the selected implementation without Crypto %s',
    async (version) => {
      const prepared = await Effect.runPromise(demoDefinition.prepare({ workflowId: 'demo', version }))
      expect(prepared).toEqual({
        graph: demoGraph(version),
        snapshot: {
          schemaVersion: 1,
          version: SemVer.format(version),
          machine: { _tag: 'MachineSnapshot', version: 2, active: [{ path: '' }, { path: 'Ready' }] },
        },
      })
      expect(Schema.is(GraphDefinition)(prepared.graph)).toBe(true)
      expect(prepared.graph.graphId).toBe(
        SemVer.equals(version, demoVersion1) ? 'demo-1_0_0-graph-1' : 'demo-2_0_0-graph-1',
      )
      expect(await Effect.runPromise(restoreDemo(fixture(version)))).toEqual(initialSnapshot(version))
    },
  )
  it.each(['v1', 'v2'])('rejects legacy snapshot version %s', async (version) => {
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(snapshotCodec)({ _tag: 'Ready', schemaVersion: 1, version })),
    ).rejects.toThrow()
  })
  it.each([
    { workflowId: 'other' },
    { graphId: 'other-graph' },
    { workflowVersion: demoVersion2 },
    { status: 'running' },
    { snapshot: { schemaVersion: 1, version: '1.0.0', machine: {} } },
  ] as const)('rejects inconsistent persisted identity or native state %j', async (change) => {
    await expect(Effect.runPromise(restoreDemo({ ...fixture(demoVersion1), ...change }))).rejects.toThrow()
  })
  it('requires native execution identities to use the owned execution schema', () => {
    const prepare = Schema.decodeUnknownSync(DemoData.cases.prepare)
    expect(prepare({ _tag: 'prepare', prepareExecutionId: 'execution_00000000-0000-4000-8000-000000000001' })).toEqual({
      _tag: 'prepare',
      prepareExecutionId: 'execution_00000000-0000-4000-8000-000000000001',
    })
    expect(() => prepare({ _tag: 'prepare', prepareExecutionId: 'run:prepare:1' })).toThrow()
  })
  it.each([
    {
      path: 'prepare',
      status: 'running',
      value: { _tag: 'prepare', prepareExecutionId: 'execution_00000000-0000-4000-8000-000000000001' },
    },
    {
      path: 'approval',
      status: 'waiting',
      value: {
        _tag: 'approval',
        prepareExecutionId: 'execution_00000000-0000-4000-8000-000000000001',
        approvalExecutionId: 'execution_00000000-0000-4000-8000-000000000002',
        prepared: 'draft:v1',
      },
    },
    {
      path: 'publish',
      status: 'running',
      value: {
        _tag: 'publish',
        prepareExecutionId: 'execution_00000000-0000-4000-8000-000000000001',
        approvalExecutionId: 'execution_00000000-0000-4000-8000-000000000002',
        publishExecutionId: 'execution_00000000-0000-4000-8000-000000000003',
        prepared: 'draft:v1',
      },
    },
  ] as const)(
    'restores $path native execution identity without Crypto and rejects malformed identity',
    async ({ path, status, value }) => {
      const snapshot = {
        schemaVersion: 1,
        version: '1.0.0',
        machine: { _tag: 'MachineSnapshot', version: 2, active: [{ path: '' }, { path, value }] },
      }
      const run = { ...fixture(demoVersion1), status, snapshot }
      expect(await Effect.runPromise(restoreDemo(run))).toEqual({ ...snapshot, version: demoVersion1 })
      const corrupted = {
        ...snapshot,
        machine: {
          ...snapshot.machine,
          active: [{ path: '' }, { path, value: { ...value, prepareExecutionId: 'checkpoint' } }],
        },
      }
      await expect(Effect.runPromise(restoreDemo({ ...run, snapshot: corrupted }))).rejects.toThrow()
    },
  )
  it.each([
    { workflowId: 'demo', version: 'v1' },
    { workflowId: 'demo', version: 'v2' },
    { workflowId: 'demo', version: SemVer.make({ major: 3, minor: 0, patch: 0 }) },
    { workflowId: 'demo', version: demoVersion1, task: 'unexpected' },
    { workflowId: 'other', version: demoVersion1 },
  ])('rejects unsupported or excess input %j', async (input) => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(DemoCreateRun)(input, { onExcessProperty: 'error' }).pipe(
          Effect.flatMap(demoDefinition.prepare),
        ),
      ),
    ).rejects.toThrow()
  })
})
