import { DateTime, Effect, Schema, SemVer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { GraphDefinition, type Run } from '@/features/workflow/domain/model'

import { demoDefinition } from './definition'
import { demoGraph, DemoSnapshot, encodeDemoSnapshot, initialSnapshot, restoreDemo } from './demo'
import { DemoCreateRun, demoVersion1, demoVersion2 } from './input'

const snapshotCodec = Schema.toCodecJson(DemoSnapshot)

describe('demo definition', () => {
  it.each([demoVersion1, demoVersion2])('keeps the published definition %s stable', async (version) => {
    const prepared = await Effect.runPromise(demoDefinition.prepare({ workflowId: 'demo', version }))
    expect(prepared).toMatchSnapshot(`demo ${SemVer.format(version)}`)
  })
  it.each([demoVersion1, demoVersion2])('prepares and restores the selected implementation %s', async (version) => {
    const prepared = await Effect.runPromise(demoDefinition.prepare({ workflowId: 'demo', version }))
    expect(prepared).toEqual({
      graph: demoGraph(version),
      snapshot: {
        _tag: 'Ready',
        schemaVersion: 1,
        version: SemVer.format(version),
        state: 'prepare',
        context: { prepared: '', result: '' },
        machine: { _tag: 'MachineSnapshot', version: 2, active: [{ path: '' }, { path: 'prepare' }] },
      },
    })
    expect(Schema.is(GraphDefinition)(prepared.graph)).toBe(true)
    expect(prepared.graph.graphId).toBe(
      SemVer.equals(version, demoVersion1) ? 'demo-1_0_0-graph-1' : 'demo-2_0_0-graph-1',
    )
    const run: Run = {
      runId: 'run_00000000-0000-4000-8000-000000000001',
      workflowId: 'demo',
      workflowVersion: SemVer.make({ major: version.major, minor: version.minor, patch: version.patch }),
      graphId: prepared.graph.graphId,
      status: 'pending',
      revision: 0,
      snapshot: prepared.snapshot,
      createdAt: DateTime.makeUnsafe('2026-10-31T00:00:00.000Z'),
      updatedAt: DateTime.makeUnsafe('2026-10-31T00:00:00.000Z'),
    }
    expect(await Effect.runPromise(restoreDemo(run))).toEqual(initialSnapshot(version))
    expect(await Effect.runPromise(encodeDemoSnapshot(initialSnapshot(version)))).toEqual(prepared.snapshot)
  })

  it.each(['v1', 'v2'])('rejects legacy snapshot version %s', async (version) => {
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(snapshotCodec)({ _tag: 'Ready', schemaVersion: 1, version })),
    ).rejects.toThrow()
  })

  it.each(['prepare', 'publish'])('validates running %s execution identity', (state) => {
    const snapshot = { ...initialSnapshot(demoVersion1), _tag: 'Running', state, attempt: 1 }
    expect(
      Schema.is(DemoSnapshot)({ ...snapshot, executionId: 'execution_00000000-0000-4000-8000-000000000001' }),
    ).toBe(true)
    expect(Schema.is(DemoSnapshot)({ ...snapshot, executionId: 'run:prepare:1' })).toBe(false)
  })

  it('validates waiting execution and failed node identities', () => {
    const waiting = { ...initialSnapshot(demoVersion1), _tag: 'Waiting', attempt: 1 }
    expect(Schema.is(DemoSnapshot)({ ...waiting, executionId: 'execution_00000000-0000-4000-8000-000000000001' })).toBe(
      true,
    )
    expect(Schema.is(DemoSnapshot)({ ...waiting, executionId: 'checkpoint' })).toBe(false)
    const failed = {
      ...waiting,
      _tag: 'Failed',
      executionId: 'execution_00000000-0000-4000-8000-000000000001',
      message: 'failed',
    }
    expect(Schema.is(DemoSnapshot)({ ...failed, state: 'prepare' })).toBe(true)
    expect(Schema.is(DemoSnapshot)({ ...failed, state: 'invalid/node' })).toBe(false)
  })

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
