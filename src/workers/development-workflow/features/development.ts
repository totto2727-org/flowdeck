import { Crypto, DateTime, Effect, Match, Schema } from 'effect'

import { InvalidOperation, InvalidSnapshot, type DomainError } from '../../../features/workflow/domain/errors'
import {
  type GraphDefinition,
  type Run,
  type RunStatus,
  type WorkflowSummary,
} from '../../../features/workflow/domain/model'
import { Store, type PendingEvent } from '../../../features/workflow/services/store'
import { DevelopmentTask, PublicRepository, DevelopmentWorkflowVersion, type DevelopmentCreateRun } from './input'
import type { TurnReceipt } from './model'
import { DevelopmentSandbox } from './sandbox'

const base = {
  schemaVersion: Schema.Literal(1),
  version: DevelopmentWorkflowVersion,
  // Compatibility: legacy snapshots remain readable, but only explicitly PiHarness runs may execute.
  runtime: Schema.Literals(['pi', 'pi-harness', 'legacy-missing']),
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
  Schema.TaggedStruct('Completing', {
    ...base,
    sessionId: Schema.String,
    result: Schema.String,
    // Older checkpoints derived this identity from the run and node.
    commandId: Schema.String,
  }),
  Schema.TaggedStruct('Completed', { ...base, sessionId: Schema.String, result: Schema.String }),
  Schema.TaggedStruct('Failed', { ...base, nodeId: Schema.Literals(['implement', 'verify']), message: Schema.String }),
])
export type DevelopmentSnapshot = typeof DevelopmentSnapshot.Type
export const developmentWorkflow: WorkflowSummary = {
  // Compatibility: persisted workflow, version and graph identities must not be renamed.
  workflowId: 'jcode-development',
  name: 'Pi development',
  versions: ['1.0.0'],
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
  // Compatibility: existing runs pin this immutable graph reference.
  graphId: 'jcode-development:v1:graph:1',
  schemaVersion: 1,
  nodes: [
    { nodeId: 'implement', label: 'Implement task', kind: 'task' },
    { nodeId: 'verify', label: 'Verify and fix', kind: 'task' },
  ],
  edges: [{ edgeId: 'implement-verify', source: 'implement', target: 'verify', label: 'implementation complete' }],
}
export const developmentGraphFor = (version: string): GraphDefinition => ({
  ...developmentGraph,
  graphId: version === 'v1' ? developmentGraph.graphId : `jcode-development:${version}:graph:1`,
})
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
const commandId = (runId: string, nodeId: 'implement' | 'verify') => `${runId}:${nodeId}:1`
const UUIDv4 = Schema.String.check(Schema.isUUID(4))
const validCommand = (id: string, runId: string, nodeId: 'implement' | 'verify') =>
  Schema.is(UUIDv4)(id) || id === commandId(runId, nodeId)
export const restoreDevelopment = (run: Run) =>
  Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(run.snapshot).pipe(
    // Persisted legacy omissions are converted once, before entering the required-field domain model.
    Effect.flatMap((wire) =>
      Schema.decodeUnknownEffect(DevelopmentSnapshot)({
        ...wire,
        runtime: 'runtime' in wire ? wire['runtime'] : 'legacy-missing',
        ...(wire['_tag'] === 'Completing' && !('commandId' in wire)
          ? { commandId: commandId(run.runId, 'verify') }
          : {}),
      }),
    ),
    Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid development snapshot' })),
    Effect.flatMap((snapshot) =>
      run.workflowId !== 'jcode-development' ||
      run.workflowVersion !== snapshot.version ||
      run.graphId !== developmentGraphFor(snapshot.version).graphId ||
      run.status !== statusFor(snapshot) ||
      (snapshot._tag === 'Starting' && !validCommand(snapshot.commandId, run.runId, 'implement')) ||
      ((snapshot._tag === 'PendingTurn' || snapshot._tag === 'AwaitingTurn') &&
        !validCommand(snapshot.commandId, run.runId, snapshot.nodeId))
        ? Effect.fail(new InvalidSnapshot({ message: 'Development run identity and snapshot must agree' }))
        : Effect.succeed(snapshot),
    ),
  )
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))
type EventDraft = Omit<PendingEvent, 'createdAt' | 'eventId'>
const nodeEvent = (
  executionId: string,
  nodeId: 'implement' | 'verify',
  type: 'node.started' | 'node.succeeded' | 'node.failed',
  payload: Record<string, unknown> = {},
): EventDraft => ({
  type,
  nodeId,
  executionId,
  attempt: 1,
  payload,
})
const runEvent = (
  _run: Run,
  type: 'run.started' | 'run.waiting' | 'run.resumed' | 'run.completed' | 'run.failed',
): EventDraft => ({
  type,
  nodeId: null,
  executionId: null,
  attempt: null,
  payload: {},
})
const save = (run: Run, snapshot: DevelopmentSnapshot, events: ReadonlyArray<EventDraft>) =>
  Effect.gen(function* () {
    const store = yield* Store
    const crypto = yield* Crypto.Crypto
    const updatedAt = yield* now
    const status = statusFor(snapshot)
    yield* store.commit({
      commitId: yield* crypto.randomUUIDv4(),
      runId: run.runId,
      expectedRevision: run.revision,
      status,
      snapshot,
      updatedAt,
      events: yield* Effect.forEach(events, (event) =>
        crypto.randomUUIDv4().pipe(Effect.map((eventId) => ({ ...event, eventId, createdAt: updatedAt }))),
      ),
    })
    return { ...run, status, snapshot, revision: run.revision + 1, updatedAt } satisfies Run
  })
const fail = (run: Run, snapshot: DevelopmentSnapshot, nodeId: 'implement' | 'verify', message: string) =>
  save(run, { ...fields(snapshot), _tag: 'Failed', nodeId, message }, [
    nodeEvent('commandId' in snapshot ? snapshot.commandId : commandId(run.runId, nodeId), nodeId, 'node.failed', {
      message,
    }),
    runEvent(run, 'run.failed'),
  ]).pipe(Effect.asVoid)
const prompt = (snapshot: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }>) =>
  snapshot.nodeId === 'implement'
    ? `Use Pi to clone the public GitHub repository ${snapshot.repository} into /workspace/project. Work only in this fixed project workspace. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Implement the following task. Do not push or deploy.\n\n${snapshot.task}`
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
    yield* save(run, { ...snapshot, _tag: 'AwaitingTurn' }, [runEvent(run, 'run.waiting')])
  })
const start = (run: Run, snapshot: Extract<DevelopmentSnapshot, { _tag: 'Ready' | 'Starting' }>) =>
  Effect.gen(function* () {
    const sandbox = yield* DevelopmentSandbox
    const crypto = yield* Crypto.Crypto
    const implementationId = snapshot._tag === 'Starting' ? snapshot.commandId : yield* crypto.randomUUIDv4()
    const starting =
      snapshot._tag === 'Ready'
        ? yield* save(run, { ...fields(snapshot), _tag: 'Starting', commandId: implementationId }, [
            runEvent(run, 'run.started'),
            nodeEvent(implementationId, 'implement', 'node.started'),
          ])
        : run
    const session = yield* sandbox.ensureSession(run.runId)
    if (session.status !== 'active')
      return yield* fail(
        starting,
        { ...fields(snapshot), _tag: 'Starting', commandId: implementationId },
        'implement',
        'Pi session is already complete',
      )
    const pending: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }> = {
      ...fields(snapshot),
      _tag: 'PendingTurn',
      sessionId: session.sessionId,
      nodeId: 'implement',
      commandId: implementationId,
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
      nodeEvent(snapshot.commandId, 'verify', 'node.succeeded', {
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
      const crypto = yield* Crypto.Crypto
      const pending: Extract<DevelopmentSnapshot, { _tag: 'PendingTurn' }> = {
        ...fields(snapshot),
        _tag: 'PendingTurn',
        nodeId: 'verify',
        commandId: yield* crypto.randomUUIDv4(),
        sessionId: snapshot.sessionId,
      }
      const current = yield* save(run, pending, [
        nodeEvent(snapshot.commandId, 'implement', 'node.succeeded', { output: receipt.text }),
        runEvent(run, 'run.resumed'),
        nodeEvent(pending.commandId, 'verify', 'node.started'),
      ])
      return yield* submitPending(current, pending)
    }
    const completing: Extract<DevelopmentSnapshot, { _tag: 'Completing' }> = {
      ...fields(snapshot),
      _tag: 'Completing',
      sessionId: snapshot.sessionId,
      result: receipt.text,
      commandId: snapshot.commandId,
    }
    const current = yield* save(run, completing, [runEvent(run, 'run.resumed')])
    yield* complete(current, completing)
  })
/** The only recovery input is committed shared-DB state. No long Pi turn is awaited. */
const drive = (
  runId: string,
  operation: 'start' | 'resume',
): Effect.Effect<void, DomainError, Store | DevelopmentSandbox | Crypto.Crypto> =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.getRun(runId)
    const snapshot = yield* restoreDevelopment(run)
    // Legacy Ready/Starting runs can also have accepted external work, so do not infer safety from their state.
    if (snapshot.runtime !== 'pi-harness')
      return yield* new InvalidOperation({
        message:
          'Legacy Jcode and direct Pi SDK runs cannot execute with PiHarness. Retain this run for inspection and create a new PiHarness run.',
      })
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
