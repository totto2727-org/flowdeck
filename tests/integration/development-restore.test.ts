import { live } from '@effect/vitest'
import { Array, Data, Effect, Predicate, Schema, SemVer, String } from 'effect'
import { describe, expect } from 'vite-plus/test'

import { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { JsonObject } from '@/core/feature/workflow/domain/model'
import type { Run } from '@/core/feature/workflow/domain/model'
import type { CommitCommand } from '@/core/feature/workflow/services/store'
import { restoreDevelopment } from '@/user-land/workflow/development/feature/development'

import { openDevelopmentFixture } from './development-d1.fixture.ts'
import { decodeSnapshot, developmentInput, developmentTime } from './development-snapshot.fixture.ts'

type Fixture = Effect.Success<typeof openDevelopmentFixture>
type LegacyInput = Readonly<{
  commandId: string
  message: string
  nodeId: string
  repository: string
  result: string
  runtime?: string
  schemaVersion: number
  sessionId: string
  task: string
  version: string
}>
type LegacyKind = 'AwaitingTurn' | 'Completed' | 'Completing' | 'Failed' | 'PendingTurn' | 'Ready' | 'Starting'
type LegacySnapshot = Data.TaggedEnum<Record<LegacyKind, LegacyInput>>
const legacySnapshots = Data.taggedEnum<LegacySnapshot>()
const legacyParameters: LegacyInput = {
  commandId: 'run_00000000-0000-4000-8000-000000000002:implement:1',
  message: 'old',
  nodeId: 'implement',
  repository: developmentInput.repository.href,
  result: 'old',
  schemaVersion: 1,
  sessionId: 'legacy-session',
  task: developmentInput.task,
  version: '1.0.0',
}
const legacyCases = [
  ['Ready', 'pending'],
  ['Starting', 'running'],
  ['PendingTurn', 'running'],
  ['AwaitingTurn', 'waiting'],
  ['Completing', 'running'],
  ['Completed', 'completed'],
  ['Failed', 'failed'],
] as const satisfies Readonly<Readonly<[LegacyKind, Run['status']]>[]>

const persistLegacy = Effect.fn('flowdeck.test.persistLegacyDevelopment')(function* (
  fixture: Fixture,
  change: Pick<CommitCommand, 'commitId' | 'snapshot' | 'status'>,
) {
  yield* fixture.store.commit({
    ...change,
    events: [],
    expectedRevision: 0,
    runId: fixture.initial.runId,
    updatedAt: developmentTime,
  })
  return yield* fixture.current
})

const noPi = {
  complete: () => Effect.die('must not complete'),
  ensureSession: () => Effect.die('must not access Pi'),
  getTurn: () => Effect.die('must not poll'),
  submitTurn: () => Effect.die('must not submit'),
}

describe.each([undefined, 'pi'] as const)('legacy runtime %s', (runtime) => {
  live.each(legacyCases)('rejects legacy %s without accessing Pi', ([kind, status]) =>
    Effect.gen(function* () {
      const fixture = yield* openDevelopmentFixture
      const fields = Predicate.isNullish(runtime) ? legacyParameters : { ...legacyParameters, runtime }
      const before = yield* persistLegacy(fixture, {
        commitId: 'commit_00000000-0000-4000-8000-000000000011',
        snapshot: legacySnapshots[kind](fields),
        status,
      })
      fixture.pi.setSandbox(noPi)
      expect(yield* Effect.flip(restoreDevelopment(before))).toBeInstanceOf(InvalidSnapshot)
      expect(yield* Effect.flip(fixture.start)).toBeInstanceOf(InvalidSnapshot)
      expect(yield* Effect.flip(fixture.resume)).toBeInstanceOf(InvalidSnapshot)
      expect(yield* fixture.current).toStrictEqual(before)
      expect(yield* fixture.events).toStrictEqual([])
    }).pipe(Effect.scoped),
  )
})

type HistoricalCompleting = Data.TaggedEnum<{
  Completing: {
    repository: string
    result: string
    runtime: 'pi-harness'
    schemaVersion: number
    sessionId: string
    task: string
    version: string
  }
}>
const { Completing } = Data.taggedEnum<HistoricalCompleting>()
const historicalCompleting = Completing({
  repository: developmentInput.repository.href,
  result: 'historical result',
  runtime: 'pi-harness',
  schemaVersion: 1,
  sessionId: '1',
  task: developmentInput.task,
  version: '1.0.0',
})

live('rejects historical completing checkpoints with missing command and execution identities', () =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    const before = yield* persistLegacy(fixture, {
      commitId: 'commit_00000000-0000-4000-8000-000000000012',
      snapshot: historicalCompleting,
      status: 'running',
    })
    expect(yield* Effect.flip(restoreDevelopment(before))).toBeInstanceOf(InvalidSnapshot)
    expect(yield* Effect.flip(fixture.resume)).toBeInstanceOf(InvalidSnapshot)
    expect(yield* fixture.current).toStrictEqual(before)
    expect(fixture.pi.read()).toMatchObject({ completeCalls: [], submissions: [] })
  }).pipe(Effect.scoped),
)

const encodeMachine = Schema.encodeEffect(Schema.toCodecJson(JsonObject))
const decodeMachine = Schema.decodeEffect(Schema.fromJsonString(JsonObject))

const corruptCommandIdentity = Effect.fn('flowdeck.test.corruptDevelopmentCommand')(function* (
  run: Run,
  commandId: string,
  invalid: string,
) {
  const snapshot = yield* decodeSnapshot(run.snapshot)
  const encoded = yield* encodeMachine(snapshot.machine)
  const raw = JSON.stringify(encoded)
  // Store malformed JSON data without changing the historical checkpoint shape.
  const machine = yield* decodeMachine(String.replaceAll(commandId, invalid)(raw))
  return { ...run, snapshot: { ...run.snapshot, machine } }
})

live.each([
  'run_00000000-0000-4000-8000-000000000002:implement:1',
  '3d360c7a-4b1a-4df3-9633-861a220bf5b7',
  '01890f2e-7b55-7cc1-8c5a-000000000001',
  'not-a-uuid',
])('rejects invalid persisted command identity %s before Pi access', (invalid) =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    yield* fixture.start
    const before = yield* fixture.current
    const {
      input: { commandId },
    } = Array.getUnsafe(fixture.pi.read().submissions, 0)
    const corrupted = yield* corruptCommandIdentity(before, commandId, invalid)
    expect(yield* Effect.flip(restoreDevelopment(corrupted))).toBeInstanceOf(InvalidSnapshot)
    expect(fixture.pi.read().submissions).toHaveLength(1)
  }).pipe(Effect.scoped),
)

const mismatchedVersion = SemVer.make({ major: 2, minor: 0, patch: 0 })
live.each([
  { workflowVersion: mismatchedVersion },
  { graphId: 'different-graph' },
  { workflowId: 'demo' },
  { status: 'running' as const },
])('rejects mismatched persisted identity or status before execution', (changed) =>
  Effect.gen(function* () {
    const fixture = yield* openDevelopmentFixture
    const stored = { ...fixture.initial, ...changed }
    expect(yield* Effect.flip(restoreDevelopment(stored))).toBeInstanceOf(InvalidSnapshot)
    expect(fixture.pi.read().submissions).toStrictEqual([])
  }).pipe(Effect.scoped),
)
