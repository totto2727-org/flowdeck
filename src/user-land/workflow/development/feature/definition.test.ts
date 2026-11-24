import { live } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { Data, DateTime, Effect, Option, Schema, SemVer, String } from 'effect'
import { expect } from 'vite-plus/test'

import { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { JsonObject } from '@/core/feature/workflow/domain/model'
import type { Run } from '@/core/feature/workflow/domain/model'

import { developmentDefinition } from './definition.ts'
import { DevelopmentMachine, DevelopmentStates } from './development-machine.ts'
import { restoreDevelopment } from './development.ts'
import { DevelopmentCreateRun, developmentVersion } from './input.ts'

const decodeSnapshot = Schema.decodeEffect(Schema.fromJsonString(JsonObject))
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The domain input intentionally supplies an untyped version.
const decodeDevelopmentCreateRun = Schema.decodeUnknownEffect(DevelopmentCreateRun)

const input = {
  repository: 'https://github.com/example/project',
  task: 'Implement the requested change.',
  version: developmentVersion,
  workflowId: 'jcode-development',
}
const timestamp = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')
const graphId = 'jcode-development-1_0_0-graph-1'
const run: Run = {
  createdAt: timestamp,
  graphId,
  revision: 1,
  runId: 'run_00000000-0000-4000-8000-000000000002',
  snapshot: {},
  status: 'running',
  updatedAt: timestamp,
  workflowId: input.workflowId,
  workflowVersion: developmentVersion,
}
const legacy = Data.taggedEnum<
  Data.TaggedEnum<{
    Completing: {
      repository: string
      result: string
      schemaVersion: number
      sessionId: string
      task: string
      version: string
    }
  }>
>()
const completing = legacy.Completing({
  repository: input.repository,
  result: 'done',
  schemaVersion: 1,
  sessionId: '1',
  task: input.task,
  version: 'v1',
})

live.each(['"runtime":"pi"', '"runtime":null', '"runtime":false', '"other":"pi-harness"'])(
  'rejects malformed native runtime %s before accessing Pi',
  (runtime) =>
    Effect.gen(function* () {
      const prepared = yield* developmentDefinition.prepare(input)
      const wire = JSON.stringify(prepared.snapshot)
      const malformed = String.replace('"runtime":"pi-harness"', runtime)(wire)
      const snapshot = yield* decodeSnapshot(malformed)
      const restore = restoreDevelopment({ ...run, snapshot, status: 'pending' })
      expect(yield* Effect.flip(restore)).toBeInstanceOf(InvalidSnapshot)
    }),
)

live('rejects omitted runtime and command identities instead of restoring them', () =>
  Effect.gen(function* () {
    const restore = restoreDevelopment({ ...run, snapshot: completing })
    expect(yield* Effect.flip(restore)).toBeInstanceOf(InvalidSnapshot)
  }),
)

live.each(['pi', 'pi-harness'])('rejects runtime %s with missing command identity', (runtime) =>
  Effect.gen(function* () {
    const restore = restoreDevelopment({ ...run, snapshot: { ...completing, runtime } })
    expect(yield* Effect.flip(restore)).toBeInstanceOf(InvalidSnapshot)
  }),
)

// oxlint-disable-next-line unicorn/no-null -- The persisted wire can contain a malformed explicit null runtime.
const nullRuntime = null

live('rejects an invalid explicit runtime instead of treating it as missing', () =>
  Effect.gen(function* () {
    const restore = restoreDevelopment({ ...run, snapshot: { ...completing, runtime: nullRuntime } })
    expect(yield* Effect.flip(restore)).toBeInstanceOf(InvalidSnapshot)
  }),
)

live('prepares the workflow-owned graph and PiHarness snapshot', () =>
  Effect.gen(function* () {
    const prepared = yield* developmentDefinition.prepare(input)
    expect(prepared).toMatchObject({
      graph: {
        edges: [
          { edgeId: 'implement-verify', label: 'implementation complete', source: 'implement', target: 'verify' },
        ],
        graphId,
        nodes: [
          { kind: 'task', label: 'Implement task', nodeId: 'implement' },
          { kind: 'task', label: 'Verify and fix', nodeId: 'verify' },
        ],
        schemaVersion: 1,
      },
      snapshot: {
        machine: { version: 2 },
        schemaVersion: 1,
        version: '1.0.0',
      },
    })
    expect(prepared.snapshot).toHaveProperty('machine._tag', 'MachineSnapshot')
  }),
)

live.each(['https://github.com/example/project', 'https://github.com/example/project.git'])(
  'preserves the validated URL string %s',
  (repository) =>
    Effect.gen(function* () {
      const prepared = yield* developmentDefinition.prepare({ ...input, repository })
      const state = yield* Machine.decodeSnapshot(DevelopmentMachine, prepared.snapshot['machine'])
      expect(Option.getOrThrow(DevelopmentStates.get(state, '')).repository.href).toBe(repository)
      expect(DevelopmentStates.matches(state, 'implement.allocate')).toBe(true)
      expect(prepared.snapshot).not.toHaveProperty('context')
    }),
)

live.each([
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
])('rejects unsafe repository %s', (repository) =>
  Effect.gen(function* () {
    const prepare = developmentDefinition.prepare({ ...input, repository })
    expect(yield* Effect.flip(prepare)).toBeInstanceOf(Schema.SchemaError)
  }),
)

live('rejects a string version at the domain boundary', () =>
  Effect.gen(function* () {
    const decode = decodeDevelopmentCreateRun({ ...input, version: '1.0.0' })
    expect(yield* Effect.flip(decode)).toBeInstanceOf(Schema.SchemaError)
  }),
)

live.each([
  { ...input, version: SemVer.make({ major: 2, minor: 0, patch: 0 }) },
  { ...input, task: '' },
  { ...input, task: '   ' },
  { ...input, task: 'x'.repeat(16_001) },
  { ...input, extra: true },
])('rejects invalid local input', (invalid) =>
  Effect.gen(function* () {
    const prepare = developmentDefinition.prepare(invalid)
    expect(yield* Effect.flip(prepare)).toBeInstanceOf(Schema.SchemaError)
  }),
)
