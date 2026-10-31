import { Crypto, Effect, Match, Ref, Schema, SemVer } from 'effect'

import { UserDefinedId } from '../../../features/identity/id'
import { InvalidOperation, InvalidSnapshot, type DomainError } from '../../../features/workflow/domain/errors'
import {
  ExecutionId,
  makeCommitId,
  makeEventId,
  makeExecutionId,
  type RunId,
} from '../../../features/workflow/domain/identity'
import { type GraphDefinition, type Run, type WorkflowSummary } from '../../../features/workflow/domain/model'
import { Store } from '../../../features/workflow/services/store'
import { DemoWorkflowVersion, demoVersion1, demoVersion2 } from './input'
import { type EventDraft, type Execution, nodeEvent, observeNode, timestamp } from './node'

const fields = { schemaVersion: Schema.Literal(1), version: DemoWorkflowVersion }
export const DemoSnapshot = Schema.Union([
  Schema.TaggedStruct('Ready', fields),
  Schema.TaggedStruct('Preparing', {
    ...fields,
    executionId: ExecutionId,
    attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.TaggedStruct('Waiting', { ...fields, prepared: Schema.String, checkpointExecutionId: ExecutionId }),
  Schema.TaggedStruct('Publishing', {
    ...fields,
    prepared: Schema.String,
    executionId: ExecutionId,
    attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.TaggedStruct('Completed', { ...fields, result: Schema.String }),
  Schema.TaggedStruct('Failed', { ...fields, nodeId: UserDefinedId, message: Schema.String }),
])
export type DemoSnapshot = typeof DemoSnapshot.Type

const demoSnapshotCodec = Schema.toCodecJson(DemoSnapshot)
const encodeSnapshot = Schema.encodeEffect(demoSnapshotCodec)
const decodeSnapshot = Schema.decodeUnknownEffect(demoSnapshotCodec)
const decodeJsonObject = Schema.decodeUnknownEffect(Schema.JsonObject)

export const encodeDemoSnapshot = (snapshot: DemoSnapshot) =>
  encodeSnapshot(snapshot).pipe(Effect.flatMap(decodeJsonObject))

export const demoWorkflow: WorkflowSummary = {
  workflowId: 'demo',
  name: 'Release checkpoint',
  versions: [demoVersion1, demoVersion2],
  inputs: [],
}

/** Both implementations are deliberately bundled. Run records select their
 * original version, never a mutable latest alias. */
export const demoGraph = (version: DemoWorkflowVersion): GraphDefinition => ({
  graphId: SemVer.equals(version, demoVersion1) ? 'demo-1_0_0-graph-1' : 'demo-2_0_0-graph-1',
  schemaVersion: 1,
  nodes: [
    {
      nodeId: 'prepare',
      label: SemVer.equals(version, demoVersion1) ? 'Prepare release' : 'Enrich release',
      kind: 'task',
    },
    { nodeId: 'approval', label: 'Manual approval', kind: 'checkpoint' },
    {
      nodeId: 'publish',
      label: SemVer.equals(version, demoVersion1) ? 'Publish release' : 'Publish enriched release',
      kind: 'task',
    },
  ],
  edges: [
    { edgeId: 'prepare-approval', source: 'prepare', target: 'approval', label: 'prepared' },
    { edgeId: 'approval-publish', source: 'approval', target: 'publish', label: 'resume' },
  ],
})
export const initialSnapshot = (version: DemoWorkflowVersion): DemoSnapshot => ({
  _tag: 'Ready',
  schemaVersion: 1,
  version,
})
const statusFor = (snapshot: DemoSnapshot) =>
  Match.value(snapshot).pipe(
    Match.tag('Ready', () => 'pending' as const),
    Match.tag('Preparing', () => 'running' as const),
    Match.tag('Publishing', () => 'running' as const),
    Match.tag('Waiting', () => 'waiting' as const),
    Match.tag('Completed', () => 'completed' as const),
    Match.tag('Failed', () => 'failed' as const),
    Match.exhaustive,
  )

/** Effect 4.0.2 does not ship the v3 experimental Machine module. This is a
 * workflow-owned tagged state, not a replacement framework or a fake Machine
 * API. The durable Schema is the complete restore boundary. */
export const restoreDemo = (run: Run) =>
  decodeSnapshot(run.snapshot).pipe(
    Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid demo snapshot' })),
    Effect.flatMap((snapshot) =>
      run.workflowId !== 'demo' ||
      !SemVer.equals(snapshot.version, run.workflowVersion) ||
      run.graphId !== demoGraph(snapshot.version).graphId ||
      statusFor(snapshot) !== run.status
        ? Effect.fail(new InvalidSnapshot({ message: 'Run identity, status, graph and snapshot must agree' }))
        : Effect.succeed(snapshot),
    ),
  )
const runEvent = (type: 'run.started' | 'run.resumed' | 'run.completed' | 'run.failed'): EventDraft => ({
  type,
  payload: {},
})
const save = (run: Run, snapshot: DemoSnapshot, events: ReadonlyArray<EventDraft>) =>
  Effect.gen(function* () {
    const store = yield* Store
    const updatedAt = yield* timestamp
    const status = statusFor(snapshot)
    const encodedSnapshot = yield* encodeDemoSnapshot(snapshot).pipe(Effect.orDie)
    yield* store.commit({
      commitId: yield* makeCommitId,
      runId: run.runId,
      expectedRevision: run.revision,
      status,
      snapshot: encodedSnapshot,
      updatedAt,
      events: yield* Effect.forEach(events, (event) =>
        makeEventId.pipe(Effect.map((eventId) => ({ ...event, eventId, createdAt: updatedAt }))),
      ),
    })
    return { ...run, status, snapshot: encodedSnapshot, revision: run.revision + 1, updatedAt } satisfies Run
  })

const prepare = (
  run: Run,
  snapshot: Extract<DemoSnapshot, { _tag: 'Ready' | 'Preparing' }>,
): Effect.Effect<void, DomainError, Store | Crypto.Crypto> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(run)
    const execution: Execution = {
      runId: run.runId,
      nodeId: 'prepare',
      executionId: snapshot._tag === 'Preparing' ? snapshot.executionId : yield* makeExecutionId,
      attempt: snapshot._tag === 'Preparing' ? snapshot.attempt : 1,
    }
    // These sample tasks are pure and therefore safely retryable after a crash.
    // Real workflow nodes must own their side-effect idempotency/reconnection.
    const task = Effect.succeed(SemVer.equals(snapshot.version, demoVersion1) ? 'draft:v1' : 'draft:v2:reviewed')
    yield* observeNode(execution, task, {
      started: (event) =>
        snapshot._tag === 'Preparing'
          ? Effect.void
          : save(
              run,
              {
                _tag: 'Preparing',
                schemaVersion: 1,
                version: snapshot.version,
                executionId: execution.executionId,
                attempt: execution.attempt,
              },
              [runEvent('run.started'), event],
            ).pipe(Effect.flatMap((next) => Ref.set(current, next))),
      succeeded: (event, prepared) =>
        Effect.gen(function* () {
          const latest = yield* Ref.get(current)
          const checkpointExecutionId = yield* makeExecutionId
          yield* save(
            latest,
            { _tag: 'Waiting', schemaVersion: 1, version: snapshot.version, prepared, checkpointExecutionId },
            [
              event,
              nodeEvent(
                { runId: run.runId, nodeId: 'approval', executionId: checkpointExecutionId, attempt: 1 },
                'node.started',
              ),
              {
                type: 'run.waiting',
                nodeId: 'approval',
                executionId: checkpointExecutionId,
                attempt: 1,
                payload: {},
              },
            ],
          )
        }),
      failed: (event) =>
        Effect.gen(function* () {
          const latest = yield* Ref.get(current)
          yield* save(
            latest,
            {
              _tag: 'Failed',
              schemaVersion: 1,
              version: snapshot.version,
              nodeId: 'prepare',
              message: 'Prepare failed',
            },
            [event, runEvent('run.failed')],
          )
        }),
    })
  })

const publish = (
  run: Run,
  snapshot: Extract<DemoSnapshot, { _tag: 'Waiting' | 'Publishing' }>,
): Effect.Effect<void, DomainError, Store | Crypto.Crypto> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(run)
    const execution: Execution = {
      runId: run.runId,
      nodeId: 'publish',
      executionId: snapshot._tag === 'Publishing' ? snapshot.executionId : yield* makeExecutionId,
      attempt: snapshot._tag === 'Publishing' ? snapshot.attempt : 1,
    }
    yield* observeNode(execution, Effect.succeed(`published:${snapshot.prepared}`), {
      started: (event) =>
        snapshot._tag === 'Publishing'
          ? Effect.void
          : save(
              run,
              {
                _tag: 'Publishing',
                schemaVersion: 1,
                version: snapshot.version,
                prepared: snapshot.prepared,
                executionId: execution.executionId,
                attempt: execution.attempt,
              },
              [
                runEvent('run.resumed'),
                nodeEvent(
                  { runId: run.runId, nodeId: 'approval', executionId: snapshot.checkpointExecutionId, attempt: 1 },
                  'node.succeeded',
                  { approved: true },
                ),
                event,
              ],
            ).pipe(Effect.flatMap((next) => Ref.set(current, next))),
      succeeded: (event, result) =>
        Effect.gen(function* () {
          const latest = yield* Ref.get(current)
          yield* save(latest, { _tag: 'Completed', schemaVersion: 1, version: snapshot.version, result }, [
            event,
            runEvent('run.completed'),
          ])
        }),
      failed: (event) =>
        Effect.gen(function* () {
          const latest = yield* Ref.get(current)
          yield* save(
            latest,
            {
              _tag: 'Failed',
              schemaVersion: 1,
              version: snapshot.version,
              nodeId: 'publish',
              message: 'Publish failed',
            },
            [event, runEvent('run.failed')],
          )
        }),
    })
  })

/** Each call reloads the canonical D1 state. No instance field, pending Promise,
 * or in-memory continuation is needed to recover a replaced Durable Object. */
const drive = (runId: RunId, operation: 'start' | 'resume'): Effect.Effect<void, DomainError, Store | Crypto.Crypto> =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.getRun(runId)
    const snapshot = yield* restoreDemo(run)
    yield* Match.value(snapshot).pipe(
      Match.tag('Ready', (state) => prepare(run, state)),
      Match.tag('Preparing', (state) => prepare(run, state)),
      Match.tag('Waiting', (state) => (operation === 'resume' ? publish(run, state) : Effect.void)),
      Match.tag('Publishing', (state) => publish(run, state)),
      Match.tag('Completed', () =>
        Effect.fail(new InvalidOperation({ message: 'Terminal runs cannot execute again' })),
      ),
      Match.tag('Failed', () => Effect.fail(new InvalidOperation({ message: 'Terminal runs cannot execute again' }))),
      Match.exhaustive,
    )
  })
export const startRun = (runId: RunId) => drive(runId, 'start')
export const resumeRun = (runId: RunId) => drive(runId, 'resume')
