import { DateTime, Effect, Schema, SemVer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { GraphDefinition, type Run } from '../../../features/workflow/domain/model'
import { demoDefinition } from './definition'
import { demoGraph, DemoSnapshot, encodeDemoSnapshot, initialSnapshot, restoreDemo } from './demo'
import { DemoCreateRun, demoVersion1, demoVersion2 } from './input'

const snapshotCodec = Schema.toCodecJson(DemoSnapshot)

describe('demo definition', () => {
  it.each([demoVersion1, demoVersion2])('prepares and restores the selected implementation %s', async (version) => {
    const prepared = await Effect.runPromise(demoDefinition.prepare({ workflowId: 'demo', version }))
    expect(prepared).toEqual({
      graph: demoGraph(version),
      snapshot: { _tag: 'Ready', schemaVersion: 1, version: SemVer.format(version) },
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

  it.each(['Preparing', 'Publishing'] as const)('validates %s execution identity', (_tag) => {
    const snapshot = { _tag, schemaVersion: 1, version: demoVersion1, attempt: 1, prepared: 'draft' }
    expect(
      Schema.is(DemoSnapshot)({ ...snapshot, executionId: 'execution_00000000-0000-4000-8000-000000000001' }),
    ).toBe(true)
    expect(Schema.is(DemoSnapshot)({ ...snapshot, executionId: 'run:prepare:1' })).toBe(false)
  })

  it('validates checkpoint and failed node identities', () => {
    const waiting = { _tag: 'Waiting', schemaVersion: 1, version: demoVersion1, prepared: 'draft' }
    expect(
      Schema.is(DemoSnapshot)({ ...waiting, checkpointExecutionId: 'execution_00000000-0000-4000-8000-000000000001' }),
    ).toBe(true)
    expect(Schema.is(DemoSnapshot)({ ...waiting, checkpointExecutionId: 'checkpoint' })).toBe(false)
    const failed = { _tag: 'Failed', schemaVersion: 1, version: demoVersion1, message: 'failed' }
    expect(Schema.is(DemoSnapshot)({ ...failed, nodeId: 'prepare' })).toBe(true)
    expect(Schema.is(DemoSnapshot)({ ...failed, nodeId: 'invalid/node' })).toBe(false)
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
