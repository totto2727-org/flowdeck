import { live } from '@effect/vitest'
import { Data, DateTime, Effect, Schema, SemVer } from 'effect'
import { describe, expect } from 'vite-plus/test'

import { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { GraphDefinition } from '@/core/feature/workflow/domain/model'
import type { Run } from '@/core/feature/workflow/domain/model'

import { demoDefinition } from './definition.ts'
import { demoGraph, DemoSnapshot, encodeDemoSnapshot, initialSnapshot, restoreDemo } from './demo.ts'
import { DemoCreateRun, demoVersion1, demoVersion2 } from './input.ts'
import { DemoData } from './node.ts'

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The request fixture contains invalid versions, identities and excess JSON fields.
const decodeDemoCreateRun = Schema.decodeUnknownEffect(DemoCreateRun)
const snapshotCodec = Schema.toCodecJson(DemoSnapshot)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Decode persisted records that predate the native snapshot schema.
const decodeSnapshotCodec = Schema.decodeUnknownEffect(snapshotCodec)
const decodePrepare = Schema.decodeEffect(DemoData.cases.prepare)
const isGraph = Schema.is(GraphDefinition)

const executionIds = {
  approval: 'execution_00000000-0000-4000-8000-000000000002',
  prepare: 'execution_00000000-0000-4000-8000-000000000001',
  publish: 'execution_00000000-0000-4000-8000-000000000003',
}

type WireExecutionData = Data.TaggedEnum<{
  approval: { approvalExecutionId: string; prepareExecutionId: string; prepared: string }
  prepare: { prepareExecutionId: string }
  publish: { approvalExecutionId: string; prepareExecutionId: string; prepared: string; publishExecutionId: string }
}>
const wireData = Data.taggedEnum<WireExecutionData>()
type NativeNode = Readonly<{ path: string; value?: WireExecutionData }>
const legacyReady = Data.taggedEnum<Data.TaggedEnum<{ Ready: { schemaVersion: 1; version: string } }>>().Ready
type WireMachineSnapshot = Data.TaggedEnum<{ MachineSnapshot: { active: NativeNode[]; version: 2 } }>
const machineSnapshot = Data.taggedEnum<WireMachineSnapshot>().MachineSnapshot
const initialNodes = [{ path: '' }, { path: 'Ready' }]

const fixture = (version: typeof demoVersion1): Effect.Effect<Run> =>
  Effect.gen(function* () {
    const initial = yield* initialSnapshot(version)
    const snapshot = yield* encodeDemoSnapshot(initial)
    const timestamp = DateTime.makeUnsafe('2026-10-31T00:00:00.000Z')
    return {
      createdAt: timestamp,
      graphId: demoGraph(version).graphId,
      revision: 0,
      runId: 'run_00000000-0000-4000-8000-000000000001',
      snapshot,
      status: 'pending',
      updatedAt: timestamp,
      workflowId: 'demo',
      workflowVersion: version,
    }
  })

describe('demo definition', () => {
  live.each([demoVersion1, demoVersion2])('keeps the published definition %s stable', (version) =>
    Effect.gen(function* () {
      const prepared = yield* demoDefinition.prepare({ version, workflowId: 'demo' })
      expect(prepared).toMatchSnapshot(`demo ${SemVer.format(version)}`)
    }),
  )

  live.each([
    { graphId: 'demo-1_0_0-graph-1', version: demoVersion1 },
    { graphId: 'demo-2_0_0-graph-1', version: demoVersion2 },
  ])('prepares and restores the selected implementation without Crypto $graphId', ({ graphId, version }) =>
    Effect.gen(function* () {
      const prepared = yield* demoDefinition.prepare({ version, workflowId: 'demo' })
      expect(prepared).toStrictEqual({
        graph: demoGraph(version),
        snapshot: {
          machine: machineSnapshot({ active: initialNodes, version: 2 }),
          schemaVersion: 1,
          version: SemVer.format(version),
        },
      })
      expect({ graphId: prepared.graph.graphId, validGraph: isGraph(prepared.graph) }).toStrictEqual({
        graphId,
        validGraph: true,
      })
      const run = yield* fixture(version)
      const initial = yield* initialSnapshot(version)
      expect(yield* restoreDemo(run)).toStrictEqual(initial)
    }),
  )
})

describe('demo persisted snapshot validation', () => {
  live.each(['v1', 'v2'])('rejects legacy snapshot version %s', (version) =>
    Effect.gen(function* () {
      const legacy = legacyReady({ schemaVersion: 1, version })
      const failure = yield* Effect.flip(decodeSnapshotCodec(legacy))
      expect(failure).toBeInstanceOf(Schema.SchemaError)
    }),
  )

  live.each([
    { workflowId: 'other' },
    { graphId: 'other-graph' },
    { workflowVersion: demoVersion2 },
    { status: 'running' },
    { snapshot: { machine: {}, schemaVersion: 1, version: '1.0.0' } },
  ] as const)('rejects inconsistent persisted identity or native state %j', (change) =>
    Effect.gen(function* () {
      const run = yield* fixture(demoVersion1)
      expect(yield* Effect.flip(restoreDemo({ ...run, ...change }))).toBeInstanceOf(InvalidSnapshot)
    }),
  )
})

const preparedExecution = {
  approvalExecutionId: executionIds.approval,
  prepareExecutionId: executionIds.prepare,
  prepared: 'draft:v1',
}
const executionStates = [
  {
    path: 'prepare',
    status: 'running',
    value: wireData.prepare({ prepareExecutionId: executionIds.prepare }),
  },
  {
    path: 'approval',
    status: 'waiting',
    value: wireData.approval(preparedExecution),
  },
  {
    path: 'publish',
    status: 'running',
    value: wireData.publish({ ...preparedExecution, publishExecutionId: executionIds.publish }),
  },
] as const

describe('demo native execution identities', () => {
  live('requires the owned execution schema when decoding prepare state', () =>
    Effect.gen(function* () {
      const input = wireData.prepare({ prepareExecutionId: executionIds.prepare })
      expect(yield* decodePrepare(input)).toStrictEqual(input)
      const checkpoint = wireData.prepare({ prepareExecutionId: 'run:prepare:1' })
      expect(yield* Effect.flip(decodePrepare(checkpoint))).toBeInstanceOf(Schema.SchemaError)
    }),
  )

  live.each(executionStates)(
    'restores $path native execution identity without Crypto and rejects malformed identity',
    ({ path, status, value }) =>
      Effect.gen(function* () {
        const snapshot = {
          machine: machineSnapshot({ active: [{ path: '' }, { path, value }], version: 2 }),
          schemaVersion: 1,
          version: '1.0.0',
        }
        const seed = yield* fixture(demoVersion1)
        const run = { ...seed, snapshot, status }
        expect(yield* restoreDemo(run)).toStrictEqual({ ...snapshot, version: demoVersion1 })
        const invalid = { ...value, prepareExecutionId: 'checkpoint' }
        const corrupted = {
          ...snapshot,
          machine: machineSnapshot({ active: [{ path: '' }, { path, value: invalid }], version: 2 }),
        }
        expect(yield* Effect.flip(restoreDemo({ ...run, snapshot: corrupted }))).toBeInstanceOf(InvalidSnapshot)
      }),
  )
})

describe('demo request decoder', () => {
  live.each([
    { version: 'v1', workflowId: 'demo' },
    { version: 'v2', workflowId: 'demo' },
    { version: SemVer.make({ major: 3, minor: 0, patch: 0 }), workflowId: 'demo' },
    { task: 'unexpected', version: demoVersion1, workflowId: 'demo' },
    { version: demoVersion1, workflowId: 'other' },
  ])('rejects unsupported or excess input %j', (input) =>
    Effect.gen(function* () {
      const prepared = decodeDemoCreateRun(input, { onExcessProperty: 'error' }).pipe(
        Effect.flatMap(demoDefinition.prepare),
      )
      expect(yield* Effect.flip(prepared)).toBeInstanceOf(Schema.SchemaError)
    }),
  )
})
