import { Array, DateTime, Effect, Match, Schema } from 'effect'

import type { TurnReceipt } from '../../../features/jcode/model'
import { InvalidOperation, InvalidSnapshot, type DomainError } from '../../../features/workflow/domain/errors'
import {
  DevelopmentTask,
  PublicRepository,
  type CreateRun,
  type GraphDefinition,
  type Run,
  type RunStatus,
  type WorkflowSummary,
} from '../../../features/workflow/domain/model'
import { Store, type PendingEvent } from '../../../features/workflow/services/store'
import { JcodeSandbox } from './sandbox'

const base = {
  schemaVersion: Schema.Literal(1),
  version: Schema.Literal('v1'),
  repository: PublicRepository,
  task: DevelopmentTask,
}
const turn = {
  ...base,
  sessionId: Schema.String,
  nodeId: Schema.Literals(['implement', 'verify']),
  commandId: Schema.String,
}
export const DevelopmentSnapshot = Schema.Union([
  Schema.TaggedStruct('Ready', base),
  Schema.TaggedStruct('Starting', { ...base, commandId: Schema.String }),
  Schema.TaggedStruct('PendingTurn', turn),
  Schema.TaggedStruct('AwaitingTurn', turn),
  Schema.TaggedStruct('Completing', { ...base, sessionId: Schema.String, result: Schema.String }),
  Schema.TaggedStruct('Completed', { ...base, sessionId: Schema.String, result: Schema.String }),
  Schema.TaggedStruct('Failed', { ...base, nodeId: Schema.Literals(['implement', 'verify']), message: Schema.String }),
])
export type DevelopmentSnapshot = typeof DevelopmentSnapshot.Type
export const developmentWorkflow: WorkflowSummary = {
  workflowId: 'jcode-development',
  name: 'Jcode development',
  versions: ['v1'],
}
export const developmentGraph: GraphDefinition = {
  graphId: 'jcode-development:v1:graph:1',
  schemaVersion: 1,
  nodes: [
    { nodeId: 'implement', label: 'Implement task', kind: 'task' },
    { nodeId: 'verify', label: 'Verify and fix', kind: 'task' },
  ],
  edges: [{ edgeId: 'implement-verify', source: 'implement', target: 'verify', label: 'implementation complete' }],
}
export const initialDevelopmentSnapshot = (
  input: Extract<CreateRun, { workflowId: 'jcode-development' }>,
): DevelopmentSnapshot => ({
  _tag: 'Ready',
  schemaVersion: 1,
  version: 'v1',
  repository: input.repository,
  task: input.task,
})
const statusFor = (snapshot: DevelopmentSnapshot): RunStatus =>
  Match.value(snapshot).pipe(
    Match.tag('Ready', () => 'pending' as const),
    Match.tag('Starting', 'PendingTurn', 'Completing', () => 'running' as const),
    Match.tag('AwaitingTurn', () => 'waiting' as const),
    Match.tag('Completed', () => 'completed' as const),
    Match.tag('Failed', () => 'failed' as const),
    Match.exhaustive,
  )
const fields = (snapshot: DevelopmentSnapshot) => ({
  schemaVersion: 1 as const,
  version: 'v1' as const,
  repository: snapshot.repository,
  task: snapshot.task,
})
const commandId = (runId: string, nodeId: 'implement' | 'verify') => `${runId}:${nodeId}:1`
export const restoreDevelopment = (run: Run) =>
  Schema.decodeUnknownEffect(DevelopmentSnapshot)(run.snapshot).pipe(
    Effect.mapError((cause) => new InvalidSnapshot({ message: 'Invalid development snapshot', cause })),
    Effect.flatMap((snapshot) =>
      run.workflowId !== 'jcode-development' ||
      run.workflowVersion !== 'v1' ||
      run.graphId !== developmentGraph.graphId ||
      run.status !== statusFor(snapshot) ||
      (snapshot._tag === 'Starting' && snapshot.commandId !== commandId(run.runId, 'implement')) ||
      ((snapshot._tag === 'PendingTurn' || snapshot._tag === 'AwaitingTurn') &&
        snapshot.commandId !== commandId(run.runId, snapshot.nodeId))
        ? Effect.fail(new InvalidSnapshot({ message: 'Development run identity and snapshot must agree' }))
        : Effect.succeed(snapshot),
    ),
  )
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))
type EventDraft = Omit<PendingEvent, 'createdAt'>
const nodeEvent = (
  runId: string,
  nodeId: 'implement' | 'verify',
  type: 'node.started' | 'node.succeeded' | 'node.failed',
  payload: Record<string, unknown> = {},
): EventDraft => ({
  eventId: `${commandId(runId, nodeId)}:${type}`,
  type,
  nodeId,
  executionId: commandId(runId, nodeId),
  attempt: 1,
  payload,
})
const runEvent = (
  run: Run,
  type: 'run.started' | 'run.waiting' | 'run.resumed' | 'run.completed' | 'run.failed',
): EventDraft => ({
  eventId: `${run.runId}:${type}:${run.revision + 1}`,
  type,
  nodeId: null,
  executionId: null,
  attempt: null,
  payload: {},
})
const save = (run: Run, snapshot: DevelopmentSnapshot, events: ReadonlyArray<EventDraft>) =>
  Effect.gen(function* () {
    const store = yield* Store
    const updatedAt = yield* now
    const status = statusFor(snapshot)
    yield* store.commit({
      commitId: `${run.runId}:revision:${run.revision + 1}`,
      runId: run.runId,
      expectedRevision: run.revision,
      status,
      snapshot,
      updatedAt,
      events: Array.map(events, (event) => ({ ...event, createdAt: updatedAt })),
    })
    return { ...run, status, snapshot, revision: run.revision + 1, updatedAt } satisfies Run
  })
const fail = (run: Run, snapshot: DevelopmentSnapshot, nodeId: 'implement' | 'verify', message: string) =>
  save(run, { ...fields(snapshot), _tag: 'Failed', nodeId, message }, [
    nodeEvent(run.runId, nodeId, 'node.failed', { message }),
    runEvent(run, 'run.failed'),
  ]).pipe(Effect.asVoid)
const prompt = (snapshot: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }>) =>
  snapshot.nodeId === 'implement'
    ? `Clone the public GitHub repository ${snapshot.repository} into /sandbox/workspace/project. Work only in this fixed project workspace. Implement the following task. Do not push or deploy.\n\n${snapshot.task}`
    : 'Continue in the same /sandbox/workspace/project repository and SDK session. Run the project checks and tests, fix failures caused by the implementation, and report checks performed and remaining limitations. Do not push or deploy.'

const submitPending = (run: Run, snapshot: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }>) =>
  Effect.gen(function* () {
    const sandbox = yield* JcodeSandbox
    const session = yield* sandbox.ensureSession(run.runId)
    if (session.sessionId !== snapshot.sessionId || session.status !== 'active') {
      return yield* fail(
        run,
        snapshot,
        snapshot.nodeId,
        'The original active SDK session is unavailable. Container retained for inspection.',
      )
    }
    // A committed command is looked up before retrying. Only authoritative absence allows the exact same submission.
    const existing = yield* sandbox.getTurn(run.runId, snapshot.commandId)
    const receipt =
      existing ?? (yield* sandbox.submitTurn(run.runId, { commandId: snapshot.commandId, prompt: prompt(snapshot) }))
    if (receipt.commandId !== snapshot.commandId)
      return yield* fail(run, snapshot, snapshot.nodeId, 'Gateway returned a different command identity')
    if (receipt.status === 'failed' || receipt.status === 'interrupted')
      return yield* fail(run, snapshot, snapshot.nodeId, receipt.error)
    yield* save(run, { ...snapshot, _tag: 'AwaitingTurn' }, [runEvent(run, 'run.waiting')])
  })
const start = (run: Run, snapshot: Extract<DevelopmentSnapshot, { _tag: 'Ready' | 'Starting' }>) =>
  Effect.gen(function* () {
    const sandbox = yield* JcodeSandbox
    const starting =
      snapshot._tag === 'Ready'
        ? yield* save(run, { ...fields(snapshot), _tag: 'Starting', commandId: commandId(run.runId, 'implement') }, [
            runEvent(run, 'run.started'),
            nodeEvent(run.runId, 'implement', 'node.started'),
          ])
        : run
    const session = yield* sandbox.ensureSession(run.runId)
    if (session.status !== 'active')
      return yield* fail(starting, snapshot, 'implement', 'SDK session is already complete')
    const pending: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }> = {
      ...fields(snapshot),
      _tag: 'PendingTurn',
      sessionId: session.sessionId,
      nodeId: 'implement',
      commandId: commandId(run.runId, 'implement'),
    }
    const current = yield* save(starting, pending, [])
    yield* submitPending(current, pending)
  })
const complete = (run: Run, snapshot: Extract<DevelopmentSnapshot, { _tag: 'Completing' }>) =>
  Effect.gen(function* () {
    const sandbox = yield* JcodeSandbox
    const original = yield* sandbox.ensureSession(run.runId)
    if (original.sessionId !== snapshot.sessionId)
      return yield* fail(run, snapshot, 'verify', 'The original SDK session is unavailable for completion')
    const session = yield* sandbox.complete(run.runId)
    if (session.sessionId !== snapshot.sessionId || session.status !== 'completed')
      return yield* fail(run, snapshot, 'verify', 'Could not complete the original SDK session')
    // Completion marks the SDK work complete, never destroys its container or workspace.
    yield* save(run, { ...snapshot, _tag: 'Completed' }, [
      nodeEvent(run.runId, 'verify', 'node.succeeded', { output: snapshot.result }),
      runEvent(run, 'run.completed'),
    ])
  })
const poll = (
  run: Run,
  snapshot: Extract<DevelopmentSnapshot, { _tag: 'AwaitingTurn' }>,
): Effect.Effect<void, DomainError, Store | JcodeSandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* JcodeSandbox
    const receipt: TurnReceipt | null = yield* sandbox.getTurn(run.runId, snapshot.commandId)
    if (receipt === null)
      return yield* fail(
        run,
        snapshot,
        snapshot.nodeId,
        'A submitted turn is missing. It will not be resubmitted automatically.',
      )
    if (receipt.commandId !== snapshot.commandId)
      return yield* fail(run, snapshot, snapshot.nodeId, 'Gateway returned a different command identity')
    if (receipt.status === 'running') return
    if (receipt.status !== 'completed') return yield* fail(run, snapshot, snapshot.nodeId, receipt.error)
    if (snapshot.nodeId === 'implement') {
      const pending: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }> = {
        ...fields(snapshot),
        _tag: 'PendingTurn',
        nodeId: 'verify',
        commandId: commandId(run.runId, 'verify'),
        sessionId: snapshot.sessionId,
      }
      const current = yield* save(run, pending, [
        nodeEvent(run.runId, 'implement', 'node.succeeded', { output: receipt.text }),
        runEvent(run, 'run.resumed'),
        nodeEvent(run.runId, 'verify', 'node.started'),
      ])
      return yield* submitPending(current, pending)
    }
    const completing: Extract<DevelopmentSnapshot, { _tag: 'Completing' }> = {
      ...fields(snapshot),
      _tag: 'Completing',
      sessionId: snapshot.sessionId,
      result: receipt.text,
    }
    const current = yield* save(run, completing, [runEvent(run, 'run.resumed')])
    yield* complete(current, completing)
  })
/** The only recovery input is committed shared-DB state. No long SDK turn is awaited. */
const drive = (runId: string, operation: 'start' | 'resume'): Effect.Effect<void, DomainError, Store | JcodeSandbox> =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.getRun(runId)
    const snapshot = yield* restoreDevelopment(run)
    yield* Match.value(snapshot).pipe(
      Match.tag('Ready', 'Starting', (state) => start(run, state)),
      Match.tag('PendingTurn', (state) => submitPending(run, state)),
      Match.tag('AwaitingTurn', (state) => (operation === 'resume' ? poll(run, state) : Effect.void)),
      Match.tag('Completing', (state) => complete(run, state)),
      Match.tag('Completed', 'Failed', () =>
        Effect.fail(new InvalidOperation({ message: 'Terminal runs cannot execute again' })),
      ),
      Match.exhaustive,
    )
  })
export const startDevelopmentRun = (runId: string) => drive(runId, 'start')
export const resumeDevelopmentRun = (runId: string) => drive(runId, 'resume')
