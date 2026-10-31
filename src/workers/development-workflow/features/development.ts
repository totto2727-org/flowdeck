import { Crypto, DateTime, Effect, Match, Schema, SemVer } from 'effect'

import { InvalidOperation, InvalidSnapshot, type DomainError } from '../../../features/workflow/domain/errors'
import {
  ExecutionId,
  makeCommitId,
  makeEventId,
  makeExecutionId,
  type RunId,
} from '../../../features/workflow/domain/identity'
import {
  JsonObject,
  type GraphDefinition,
  type Run,
  type RunStatus,
  type WorkflowSummary,
} from '../../../features/workflow/domain/model'
import { Store, type PendingEvent } from '../../../features/workflow/services/store'
import {
  developmentVersion,
  DevelopmentTask,
  PublicRepository,
  DevelopmentWorkflowVersion,
  type DevelopmentCreateRun,
} from './input'
import { CommandId, SessionId, makeCommandId, type TurnReceipt } from './model'
import { DevelopmentSandbox } from './sandbox'

const base = {
  schemaVersion: Schema.Literal(1),
  version: DevelopmentWorkflowVersion,
  runtime: Schema.Literal('pi-harness'),
  repository: PublicRepository,
  task: DevelopmentTask,
}
const turn = {
  ...base,
  sessionId: SessionId,
  nodeId: Schema.Literals(['implement', 'verify']),
  commandId: CommandId,
  executionId: ExecutionId,
}
export const DevelopmentSnapshot = Schema.Union([
  Schema.TaggedStruct('Ready', base),
  Schema.TaggedStruct('Starting', { ...base, commandId: CommandId, executionId: ExecutionId }),
  Schema.TaggedStruct('PendingTurn', turn),
  Schema.TaggedStruct('AwaitingTurn', turn),
  Schema.TaggedStruct('Completing', {
    ...base,
    sessionId: SessionId,
    result: Schema.String,
    commandId: CommandId,
    executionId: ExecutionId,
  }),
  Schema.TaggedStruct('Completed', { ...base, sessionId: SessionId, result: Schema.String }),
  Schema.TaggedStruct('Failed', { ...base, nodeId: Schema.Literals(['implement', 'verify']), message: Schema.String }),
])
export const DevelopmentSnapshotJson = Schema.toCodecJson(DevelopmentSnapshot)
const decodeSnapshot = Schema.decodeUnknownEffect(DevelopmentSnapshotJson)
const encodeSnapshot = Schema.encodeSync(DevelopmentSnapshotJson)
const decodeJsonObject = Schema.decodeUnknownSync(JsonObject)
export type DevelopmentSnapshot = typeof DevelopmentSnapshot.Type
export const developmentWorkflow: WorkflowSummary = {
  workflowId: 'jcode-development',
  name: 'Pi development',
  versions: [developmentVersion],
  inputs: [
    {
      name: 'repository',
      label: 'Public GitHub repository',
      kind: 'text',
      required: true,
      placeholder: 'https://github.com/owner/repository',
      maxLength: 256,
    },
    {
      name: 'task',
      label: 'Development task',
      kind: 'textarea',
      required: true,
      placeholder: 'Describe the change to implement and verify.',
      maxLength: 16_000,
    },
  ],
}
export const developmentGraph: GraphDefinition = {
  graphId: 'jcode-development-1_0_0-graph-1',
  schemaVersion: 1,
  nodes: [
    { nodeId: 'implement', label: 'Implement task', kind: 'task' },
    { nodeId: 'verify', label: 'Verify and fix', kind: 'task' },
  ],
  edges: [{ edgeId: 'implement-verify', source: 'implement', target: 'verify', label: 'implementation complete' }],
}
export const developmentGraphFor = (_version: typeof DevelopmentWorkflowVersion.Type): GraphDefinition =>
  developmentGraph
export const initialDevelopmentSnapshot = (input: DevelopmentCreateRun): DevelopmentSnapshot => ({
  _tag: 'Ready',
  schemaVersion: 1,
  version: input.version,
  runtime: 'pi-harness',
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
  version: snapshot.version,
  runtime: snapshot.runtime,
  repository: snapshot.repository,
  task: snapshot.task,
})
export const restoreDevelopment = (run: Run) =>
  decodeSnapshot(run.snapshot).pipe(
    Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid development snapshot' })),
    Effect.flatMap((snapshot) =>
      run.workflowId !== 'jcode-development' ||
      !SemVer.Equivalence(run.workflowVersion, snapshot.version) ||
      run.graphId !== developmentGraphFor(snapshot.version).graphId ||
      run.status !== statusFor(snapshot)
        ? Effect.fail(new InvalidSnapshot({ message: 'Development run identity and snapshot must agree' }))
        : Effect.succeed(snapshot),
    ),
  )
const now = DateTime.now
type Draft<Event> = Event extends PendingEvent ? Omit<Event, 'createdAt' | 'eventId'> : never
type EventDraft = Draft<PendingEvent>
const nodeEvent = (
  executionId: ExecutionId,
  nodeId: 'implement' | 'verify',
  type: 'node.started' | 'node.succeeded' | 'node.failed' | 'run.waiting',
  payload: JsonObject = {},
): EventDraft => ({
  type,
  nodeId,
  executionId,
  attempt: 1,
  payload,
})
const runEvent = (_run: Run, type: 'run.started' | 'run.resumed' | 'run.completed' | 'run.failed'): EventDraft => ({
  type,
  payload: {},
})
const save = (run: Run, snapshot: DevelopmentSnapshot, events: ReadonlyArray<EventDraft>) =>
  Effect.gen(function* () {
    const store = yield* Store
    const updatedAt = yield* now
    const status = statusFor(snapshot)
    const snapshotJson = decodeJsonObject(encodeSnapshot(snapshot))
    yield* store.commit({
      commitId: yield* makeCommitId,
      runId: run.runId,
      expectedRevision: run.revision,
      status,
      snapshot: snapshotJson,
      updatedAt,
      events: yield* Effect.forEach(events, (event) =>
        makeEventId.pipe(Effect.map((eventId) => ({ ...event, eventId, createdAt: updatedAt }))),
      ),
    })
    return {
      ...run,
      status,
      snapshot: snapshotJson,
      revision: run.revision + 1,
      updatedAt,
    } satisfies Run
  })
const fail = (
  run: Run,
  snapshot: Extract<DevelopmentSnapshot, { executionId: ExecutionId }>,
  nodeId: 'implement' | 'verify',
  message: string,
) =>
  save(run, { ...fields(snapshot), _tag: 'Failed', nodeId, message }, [
    nodeEvent(snapshot.executionId, nodeId, 'node.failed', {
      message,
    }),
    runEvent(run, 'run.failed'),
  ]).pipe(Effect.asVoid)
const prompt = (snapshot: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }>) =>
  snapshot.nodeId === 'implement'
    ? `Use Pi to clone the public GitHub repository ${snapshot.repository.href} into /workspace/project. Work only in this fixed project workspace. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Implement the following task. Do not push or deploy.\n\n${snapshot.task}`
    : 'Continue with Pi in the same /workspace/project repository and session. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Run the project checks and tests, fix failures caused by the implementation, and report checks performed and remaining limitations. Do not push or deploy.'

const submitPending = (run: Run, snapshot: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }>) =>
  Effect.gen(function* () {
    const sandbox = yield* DevelopmentSandbox
    const session = yield* sandbox.ensureSession(run.runId)
    if (session.sessionId !== snapshot.sessionId || session.status !== 'active') {
      return yield* fail(
        run,
        snapshot,
        snapshot.nodeId,
        'The original active Pi session is unavailable. Container retained for inspection.',
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
    yield* save(run, { ...snapshot, _tag: 'AwaitingTurn' }, [
      nodeEvent(snapshot.executionId, snapshot.nodeId, 'run.waiting'),
    ])
  })
const start = (run: Run, snapshot: Extract<DevelopmentSnapshot, { _tag: 'Ready' | 'Starting' }>) =>
  Effect.gen(function* () {
    const sandbox = yield* DevelopmentSandbox
    const implementationId = snapshot._tag === 'Starting' ? snapshot.commandId : yield* makeCommandId
    const executionId = snapshot._tag === 'Starting' ? snapshot.executionId : yield* makeExecutionId
    const starting =
      snapshot._tag === 'Ready'
        ? yield* save(run, { ...fields(snapshot), _tag: 'Starting', commandId: implementationId, executionId }, [
            runEvent(run, 'run.started'),
            nodeEvent(executionId, 'implement', 'node.started'),
          ])
        : run
    const session = yield* sandbox.ensureSession(run.runId)
    if (session.status !== 'active')
      return yield* fail(
        starting,
        { ...fields(snapshot), _tag: 'Starting', commandId: implementationId, executionId },
        'implement',
        'Pi session is already complete',
      )
    const pending: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }> = {
      ...fields(snapshot),
      _tag: 'PendingTurn',
      sessionId: session.sessionId,
      nodeId: 'implement',
      commandId: implementationId,
      executionId,
    }
    const current = yield* save(starting, pending, [])
    yield* submitPending(current, pending)
  })
const complete = (run: Run, snapshot: Extract<DevelopmentSnapshot, { _tag: 'Completing' }>) =>
  Effect.gen(function* () {
    const sandbox = yield* DevelopmentSandbox
    const original = yield* sandbox.ensureSession(run.runId)
    if (original.sessionId !== snapshot.sessionId)
      return yield* fail(run, snapshot, 'verify', 'The original Pi session is unavailable for completion')
    const session = yield* sandbox.complete(run.runId)
    if (session.sessionId !== snapshot.sessionId || session.status !== 'completed')
      return yield* fail(run, snapshot, 'verify', 'Could not complete the original Pi session')
    // Completion marks the Pi work complete, never destroys its container or workspace.
    yield* save(run, { ...snapshot, _tag: 'Completed' }, [
      nodeEvent(snapshot.executionId, 'verify', 'node.succeeded', {
        output: snapshot.result,
      }),
      runEvent(run, 'run.completed'),
    ])
  })
const poll = (
  run: Run,
  snapshot: Extract<DevelopmentSnapshot, { _tag: 'AwaitingTurn' }>,
): Effect.Effect<void, DomainError, Store | DevelopmentSandbox | Crypto.Crypto> =>
  Effect.gen(function* () {
    const sandbox = yield* DevelopmentSandbox
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
        commandId: yield* makeCommandId,
        executionId: yield* makeExecutionId,
        sessionId: snapshot.sessionId,
      }
      const current = yield* save(run, pending, [
        nodeEvent(snapshot.executionId, 'implement', 'node.succeeded', { output: receipt.text }),
        runEvent(run, 'run.resumed'),
        nodeEvent(pending.executionId, 'verify', 'node.started'),
      ])
      return yield* submitPending(current, pending)
    }
    const completing: Extract<DevelopmentSnapshot, { _tag: 'Completing' }> = {
      ...fields(snapshot),
      _tag: 'Completing',
      sessionId: snapshot.sessionId,
      result: receipt.text,
      commandId: snapshot.commandId,
      executionId: snapshot.executionId,
    }
    const current = yield* save(run, completing, [runEvent(run, 'run.resumed')])
    yield* complete(current, completing)
  })
/** The only recovery input is committed shared-DB state. No long Pi turn is awaited. */
const drive = (
  runId: RunId,
  operation: 'start' | 'resume',
): Effect.Effect<void, DomainError, Store | DevelopmentSandbox | Crypto.Crypto> =>
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
export const startDevelopmentRun = (runId: RunId) => drive(runId, 'start')
export const resumeDevelopmentRun = (runId: RunId) => drive(runId, 'resume')
