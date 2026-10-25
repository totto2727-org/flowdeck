import { Crypto, Effect, Match, Ref, Schema } from 'effect'

import { InvalidOperation, InvalidSnapshot, type DomainError } from '../../../features/workflow/domain/errors'
import { makeCommitId, makeEventId, makeExecutionId } from '../../../features/workflow/domain/identity'
import { type GraphDefinition, type Run, type WorkflowSummary } from '../../../features/workflow/domain/model'
import { Store } from '../../../features/workflow/services/store'
import { DemoWorkflowVersion } from './input'
import { type EventDraft, type Execution, nodeEvent, observeNode, timestamp } from './node'

const fields = { schemaVersion: Schema.Literal(1), version: DemoWorkflowVersion }
export const DemoSnapshot = Schema.Union([
  Schema.TaggedStruct('Ready', fields),
  Schema.TaggedStruct('Preparing', {
    ...fields,
    executionId: Schema.String,
    attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.TaggedStruct('Waiting', { ...fields, prepared: Schema.String, checkpointExecutionId: Schema.String }),
  Schema.TaggedStruct('Publishing', {
    ...fields,
    prepared: Schema.String,
    executionId: Schema.String,
    attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.TaggedStruct('Completed', { ...fields, result: Schema.String }),
  Schema.TaggedStruct('Failed', { ...fields, nodeId: Schema.String, message: Schema.String }),
])
export type DemoSnapshot = typeof DemoSnapshot.Type

export const demoWorkflow: WorkflowSummary = {
  workflowId: 'demo',
  name: 'Release checkpoint',
  versions: ['1.0.0', '2.0.0'],
  inputs: [],
}

/** Both implementations are deliberately bundled. Run records select their
 * original version, never a mutable latest alias. */
export const demoGraph = (version: DemoWorkflowVersion): GraphDefinition => ({
  graphId: `demo:${version}:graph:1`,
  schemaVersion: 1,
  nodes: [
    {
      nodeId: 'prepare',
      label: version === 'v1' || version === '1.0.0' ? 'Prepare release' : 'Enrich release',
      kind: 'task',
    },
    { nodeId: 'approval', label: 'Manual approval', kind: 'checkpoint' },
    {
      nodeId: 'publish',
      label: version === 'v1' || version === '1.0.0' ? 'Publish release' : 'Publish enriched release',
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
  Schema.decodeUnknownEffect(DemoSnapshot)(run.snapshot).pipe(
    Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid demo snapshot' })),
    Effect.flatMap((snapshot) =>
      run.workflowId !== 'demo' ||
      snapshot.version !== run.workflowVersion ||
      run.graphId !== demoGraph(snapshot.version).graphId ||
      statusFor(snapshot) !== run.status
        ? Effect.fail(new InvalidSnapshot({ message: 'Run identity, status, graph and snapshot must agree' }))
        : Effect.succeed(snapshot),
    ),
  )
const runEvent = (
  _run: Run,
  type: 'run.started' | 'run.waiting' | 'run.resumed' | 'run.completed' | 'run.failed',
  nodeId: string | null = null,
): EventDraft => ({
  type,
  nodeId,
  executionId: null,
  attempt: null,
  payload: {},
})
const save = (run: Run, snapshot: DemoSnapshot, events: ReadonlyArray<EventDraft>) =>
  Effect.gen(function* () {
    const store = yield* Store
    const updatedAt = yield* timestamp
    const status = statusFor(snapshot)
    yield* store.commit({
      commitId: yield* makeCommitId(),
      runId: run.runId,
      expectedRevision: run.revision,
      status,
      snapshot,
      updatedAt,
      events: yield* Effect.forEach(events, (event) =>
        makeEventId().pipe(Effect.map((eventId) => ({ ...event, eventId, createdAt: updatedAt }))),
      ),
    })
    return { ...run, status, snapshot, revision: run.revision + 1, updatedAt } satisfies Run
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
      executionId: snapshot._tag === 'Preparing' ? snapshot.executionId : yield* makeExecutionId(),
      attempt: snapshot._tag === 'Preparing' ? snapshot.attempt : 1,
    }
    // These sample tasks are pure and therefore safely retryable after a crash.
    // Real workflow nodes must own their side-effect idempotency/reconnection.
    const task = Effect.succeed(
      snapshot.version === 'v1' || snapshot.version === '1.0.0' ? 'draft:v1' : 'draft:v2:reviewed',
    )
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
              [runEvent(run, 'run.started'), event],
            ).pipe(Effect.flatMap((next) => Ref.set(current, next))),
      succeeded: (event, prepared) =>
        Effect.gen(function* () {
          const latest = yield* Ref.get(current)
          const checkpointExecutionId = yield* makeExecutionId()
          yield* save(
            latest,
            { _tag: 'Waiting', schemaVersion: 1, version: snapshot.version, prepared, checkpointExecutionId },
            [
              event,
              nodeEvent(
                { runId: run.runId, nodeId: 'approval', executionId: checkpointExecutionId, attempt: 1 },
                'node.started',
              ),
              runEvent(latest, 'run.waiting', 'approval'),
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
            [event, runEvent(latest, 'run.failed')],
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
      executionId: snapshot._tag === 'Publishing' ? snapshot.executionId : yield* makeExecutionId(),
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
                runEvent(run, 'run.resumed'),
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
            runEvent(latest, 'run.completed'),
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
            [event, runEvent(latest, 'run.failed')],
          )
        }),
    })
  })

/** Each call reloads the canonical D1 state. No instance field, pending Promise,
 * or in-memory continuation is needed to recover a replaced Durable Object. */
const drive = (runId: string, operation: 'start' | 'resume'): Effect.Effect<void, DomainError, Store | Crypto.Crypto> =>
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
export const startRun = (runId: string) => drive(runId, 'start')
export const resumeRun = (runId: string) => drive(runId, 'resume')
