import { Context, Effect, Match, Ref, Schema, SemVer } from 'effect'

import { UserDefinedId } from '../../../features/identity/id'
import { InvalidOperation, InvalidSnapshot } from '../../../features/workflow/domain/errors'
import {
  ExecutionId,
  makeCommitIdGenerator,
  makeEventIdGenerator,
  makeExecutionIdGenerator,
  type RunId,
} from '../../../features/workflow/domain/identity'
import { type GraphDefinition, type Run, type WorkflowSummary } from '../../../features/workflow/domain/model'
import { Store } from '../../../features/workflow/services/store'
import { DemoWorkflowVersion, demoVersion1, demoVersion2 } from './input'
import { type EventDraft, type Execution, nodeEvent, observeNode, timestamp } from './node'
import { demoVersion1Definition } from './version-1'
import { demoVersion2Definition } from './version-2'

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
]).pipe(Schema.toTaggedUnion('_tag'))
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

const demoImplementation = (version: DemoWorkflowVersion) =>
  Match.value(version).pipe(
    Match.when(
      (selected) => SemVer.equals(selected, demoVersion1),
      () => demoVersion1Definition,
    ),
    Match.when(
      (selected) => SemVer.equals(selected, demoVersion2),
      () => demoVersion2Definition,
    ),
    Match.orElseAbsurd,
  )
export const demoGraph = (version: DemoWorkflowVersion): GraphDefinition => demoImplementation(version).graph
export const initialSnapshot = (version: DemoWorkflowVersion): DemoSnapshot =>
  DemoSnapshot.cases.Ready.make({
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
const makeSave = Effect.gen(function* () {
  const store = yield* Store
  const commitId = yield* makeCommitIdGenerator
  const eventId = yield* makeEventIdGenerator
  return Effect.fn('Demo.save')(function* (run: Run, snapshot: DemoSnapshot, events: ReadonlyArray<EventDraft>) {
    const updatedAt = yield* timestamp
    const status = statusFor(snapshot)
    const encodedSnapshot = yield* encodeDemoSnapshot(snapshot).pipe(Effect.orDie)
    yield* store.commit({
      commitId: yield* commitId(),
      runId: run.runId,
      expectedRevision: run.revision,
      status,
      snapshot: encodedSnapshot,
      updatedAt,
      events: yield* Effect.forEach(events, (event) =>
        eventId().pipe(Effect.map((eventId) => ({ ...event, eventId, createdAt: updatedAt }))),
      ),
    })
    return { ...run, status, snapshot: encodedSnapshot, revision: run.revision + 1, updatedAt } satisfies Run
  })
})

const makePrepare = Effect.gen(function* () {
  const save = yield* makeSave
  const executionId = yield* makeExecutionIdGenerator
  return Effect.fn('Demo.prepare')(function* (
    run: Run,
    snapshot: Extract<DemoSnapshot, { _tag: 'Ready' | 'Preparing' }>,
  ) {
    const current = yield* Ref.make(run)
    const execution: Execution = {
      runId: run.runId,
      nodeId: 'prepare',
      executionId: snapshot._tag === 'Preparing' ? snapshot.executionId : yield* executionId(),
      attempt: snapshot._tag === 'Preparing' ? snapshot.attempt : 1,
    }
    // These sample tasks are pure and therefore safely retryable after a crash.
    // Real workflow nodes must own their side-effect idempotency/reconnection.
    const task = demoImplementation(snapshot.version).prepare
    yield* observeNode(execution, task, {
      started: (event) =>
        snapshot._tag === 'Preparing'
          ? Effect.void
          : save(
              run,
              DemoSnapshot.cases.Preparing.make({
                schemaVersion: 1,
                version: snapshot.version,
                executionId: execution.executionId,
                attempt: execution.attempt,
              }),
              [runEvent('run.started'), event],
            ).pipe(Effect.flatMap((next) => Ref.set(current, next))),
      succeeded: (event, prepared) =>
        Effect.gen(function* () {
          const latest = yield* Ref.get(current)
          const checkpointExecutionId = yield* executionId()
          yield* save(
            latest,
            DemoSnapshot.cases.Waiting.make({
              schemaVersion: 1,
              version: snapshot.version,
              prepared,
              checkpointExecutionId,
            }),
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
            DemoSnapshot.cases.Failed.make({
              schemaVersion: 1,
              version: snapshot.version,
              nodeId: 'prepare',
              message: 'Prepare failed',
            }),
            [event, runEvent('run.failed')],
          )
        }),
    })
  })
})

const makePublish = Effect.gen(function* () {
  const save = yield* makeSave
  const executionId = yield* makeExecutionIdGenerator
  return Effect.fn('Demo.publish')(function* (
    run: Run,
    snapshot: Extract<DemoSnapshot, { _tag: 'Waiting' | 'Publishing' }>,
  ) {
    const current = yield* Ref.make(run)
    const execution: Execution = {
      runId: run.runId,
      nodeId: 'publish',
      executionId: snapshot._tag === 'Publishing' ? snapshot.executionId : yield* executionId(),
      attempt: snapshot._tag === 'Publishing' ? snapshot.attempt : 1,
    }
    yield* observeNode(execution, Effect.succeed(`published:${snapshot.prepared}`), {
      started: (event) =>
        snapshot._tag === 'Publishing'
          ? Effect.void
          : save(
              run,
              DemoSnapshot.cases.Publishing.make({
                schemaVersion: 1,
                version: snapshot.version,
                prepared: snapshot.prepared,
                executionId: execution.executionId,
                attempt: execution.attempt,
              }),
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
          yield* save(
            latest,
            DemoSnapshot.cases.Completed.make({ schemaVersion: 1, version: snapshot.version, result }),
            [event, runEvent('run.completed')],
          )
        }),
      failed: (event) =>
        Effect.gen(function* () {
          const latest = yield* Ref.get(current)
          yield* save(
            latest,
            DemoSnapshot.cases.Failed.make({
              schemaVersion: 1,
              version: snapshot.version,
              nodeId: 'publish',
              message: 'Publish failed',
            }),
            [event, runEvent('run.failed')],
          )
        }),
    })
  })
})

/** Each call reloads the canonical D1 state. No instance field, pending Promise,
 * or in-memory continuation is needed to recover a replaced Durable Object. */
const makeDrive = Effect.gen(function* () {
  const store = yield* Store
  const prepare = yield* makePrepare
  const publish = yield* makePublish
  return Effect.fn('Demo.drive')(function* (runId: RunId, operation: 'start' | 'resume') {
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
})

export const makeDemoExecutor = Effect.gen(function* () {
  const drive = yield* makeDrive
  return {
    start: (runId: RunId) => drive(runId, 'start'),
    resume: (runId: RunId) => drive(runId, 'resume'),
  }
})

export class DemoExecutor extends Context.Service<DemoExecutor, Effect.Success<typeof makeDemoExecutor>>()(
  'flowdeck/DemoExecutor',
) {}

export const startRun = (runId: RunId) => Effect.flatMap(makeDemoExecutor, (executor) => executor.start(runId))
export const resumeRun = (runId: RunId) => Effect.flatMap(makeDemoExecutor, (executor) => executor.resume(runId))
