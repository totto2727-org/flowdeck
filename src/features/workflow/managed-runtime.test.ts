import { BrowserCrypto } from '@effect/platform-browser'
import { Machine } from '@typeonce/effect-machine'
import { Array, Cause, Context, DateTime, Deferred, Effect, Exit, HashSet, Schema } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { ExternalError, InvalidSnapshot } from '@/features/workflow/domain/errors'
import type { GraphDefinition, Run, RunStatus } from '@/features/workflow/domain/model'
import { LifecycleHook, type EventDraft } from '@/features/workflow/lifecycle'
import { ResourceStore } from '@/features/workflow/resource-store'
import type { WorkflowFailure } from '@/features/workflow/services/failures'
import { type CommitCommand, Store, type StoreFailure, type StoreService } from '@/features/workflow/services/store'

import {
  encodeManagedSnapshot,
  makeManagedExecutor,
  restoreManagedSnapshot,
  ResumeEvent,
  WorkflowCheckpoint,
} from './managed-runtime'

const decodeVersion = Schema.decodeUnknownSync(Schema.SemVerFromString)
const version = decodeVersion('1.0.0')
const runId = 'run_00000000-0000-4000-8000-000000000001'
const executionId = 'execution_00000000-0000-4000-8000-000000000001'
const unavailable = new ExternalError({ kind: 'storage', operation: 'test commit', cause: 'offline' })
const graph: GraphDefinition = { graphId: 'managed-test-1', schemaVersion: 1, nodes: [], edges: [] }

class NativeResource extends Context.Service<NativeResource, { readonly call: () => void }>()('test/NativeResource') {}

const makeHarness = (multipleCheckpoints = false) => {
  const external = vi.fn()
  const resourceInitialized = vi.fn(() => ({}))
  const resourceCalled = vi.fn()
  const resourceReleased = vi.fn()
  const started = vi.fn()
  const resumed = vi.fn()
  let finish = true
  let transportFailure = false
  let businessFailure = false
  let invalidPhase = false
  let receipts = HashSet.empty<string>()
  const states = Machine.state({
    states: {
      Pending: {},
      A: {},
      Another: {},
      ASecond: Schema.TaggedStruct('ASecond', { phase: Schema.Int.check(Schema.isGreaterThan(0)) }),
      Waiting: {},
      Check: {},
      B: {},
      Final: { type: 'final' },
      Failed: { type: 'final' },
    },
  })
  const events = Machine.eventsFromSchemas(ResumeEvent)
  const node = (nodeId: string) => ({ nodeId, executionId, attempt: 1 })
  const effect = (name: string, drafts: ReadonlyArray<EventDraft>) =>
    Effect.gen(function* () {
      const checkpoint = yield* WorkflowCheckpoint
      expect(checkpoint.runId).toBe(runId)
      yield* checkpoint.checkpoint(drafts)
      const resources = yield* ResourceStore
      const resource = yield* resources.getOrTryInit(
        NativeResource,
        Effect.acquireRelease(
          Effect.sync(() => {
            const owner = resourceInitialized()
            return {
              owner,
              call: () => {
                resourceCalled(owner)
              },
            }
          }),
          (value) =>
            Effect.sync(() => {
              resourceReleased(value.owner)
            }),
        ),
      )
      resource.call()
      // The native task adapter reconciles authoritative provider receipts.
      // The shared host deliberately makes no external idempotency decisions.
      if (!HashSet.has(receipts, name)) {
        external(name)
        receipts = HashSet.add(receipts, name)
      }
    })
  const native = Machine.make({
    id: 'managed-test',
    root: states,
    events,
    effects: {
      prepare: Effect.void,
      a: effect('A', [
        { type: 'run.started', payload: {} },
        { type: 'node.started', ...node('A'), payload: {} },
      ]),
      another: Effect.sync(() => ({ multipleCheckpoints, businessFailure, invalidPhase })),
      secondA: effect('A phase 2', []),
      check: Effect.gen(function* () {
        const checkpoint = yield* WorkflowCheckpoint
        if (transportFailure) return yield* checkpoint.fail(unavailable)
        return finish
      }),
      b: effect('B', [{ type: 'node.started', ...node('B'), payload: {} }]),
    },
    branches: {
      checked: { finish: { target: 'B' }, wait: { target: 'Waiting' } },
      nextA: { again: { target: 'ASecond' }, wait: { target: 'Waiting' }, failed: { target: 'Failed' } },
    },
  }).handle({
    initial: { target: 'Pending' },
    states: {
      Pending: { invoke: { src: 'prepare', onDone: { target: 'A' } } },
      A: { invoke: { src: 'a', onDone: { target: 'Another' } } },
      Another: {
        invoke: {
          src: 'another',
          onDone: {
            branches: 'nextA',
            resolve: ({ output, select }) =>
              output.businessFailure
                ? select.failed()
                : output.multipleCheckpoints
                  ? select.again({ data: { phase: output.invalidPhase ? 0 : 1 } })
                  : select.wait(),
          },
        },
      },
      ASecond: { invoke: { src: 'secondA', onDone: { target: 'Waiting' } } },
      Waiting: { on: { Resume: { target: 'Check' } } },
      Check: {
        invoke: {
          src: 'check',
          onDone: { branches: 'checked', resolve: ({ output, select }) => (output ? select.finish() : select.wait()) },
        },
      },
      B: { invoke: { src: 'b', onDone: { target: 'Final' } } },
      Final: {},
      Failed: {},
    },
  })
  type State = Machine.Machine.Snapshot<Machine.Machine.States<typeof native>>
  const status = (state: State): RunStatus =>
    states.matches(state, 'Pending')
      ? 'pending'
      : states.matches(state, 'Waiting')
        ? 'waiting'
        : states.matches(state, 'Final')
          ? 'completed'
          : states.matches(state, 'Failed')
            ? 'failed'
            : 'running'
  const decodeJson = Schema.decodeUnknownEffect(Schema.JsonObject)
  const program = {
    decode: (encoded: Schema.JsonObject['Type']) =>
      Machine.decodeSnapshot(native, encoded).pipe(
        Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid native test state' })),
      ),
    encode: (state: State) =>
      Machine.encodeSnapshot(native, state).pipe(
        Effect.flatMap(decodeJson),
        Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid native test encoding' })),
      ),
    start: (_state: State) => Effect.sync(() => started()).pipe(Effect.andThen(Machine.start(native))),
    resume: (state: State) => Effect.sync(() => resumed()).pipe(Effect.andThen(Machine.resume(native, state))),
    isReplyBoundary: (state: State) =>
      states.matches(state, 'Waiting') || states.matches(state, 'Final') || states.matches(state, 'Failed'),
    status,
    boundaryEvents: (state: State): ReadonlyArray<EventDraft> =>
      states.matches(state, 'Failed')
        ? [
            { type: 'node.failed', ...node('A'), payload: { reason: 'invalid' } },
            { type: 'run.failed', payload: {} },
          ]
        : states.matches(state, 'Waiting')
          ? [
              { type: 'node.succeeded', ...node('A'), payload: {} },
              { type: 'run.waiting', ...node('A'), payload: {} },
            ]
          : [
              { type: 'node.succeeded', ...node('B'), payload: {} },
              { type: 'run.completed', payload: {} },
            ],
    mapError: (error: unknown): WorkflowFailure =>
      error instanceof ExternalError ? error : new InvalidSnapshot({ message: 'Native test execution failed' }),
  }
  const initial = Effect.runSync(Machine.planInitial(native)).state
  let current: Run = {
    runId,
    workflowId: 'managed-test',
    workflowVersion: version,
    graphId: graph.graphId,
    status: 'pending',
    revision: 0,
    snapshot: encodeManagedSnapshot({ schemaVersion: 1, version, machine: Effect.runSync(program.encode(initial)) }),
    createdAt: DateTime.makeUnsafe('2026-11-01T00:00:00Z'),
    updatedAt: DateTime.makeUnsafe('2026-11-01T00:00:00Z'),
  }
  let commits: ReadonlyArray<CommitCommand> = []
  let beforeCommit: (command: CommitCommand) => Effect.Effect<void, StoreFailure> = () => Effect.void
  const store: StoreService = {
    create: () => Effect.void,
    listRuns: Effect.sync(() => [current]),
    getRun: () => Effect.sync(() => current),
    getGraph: () => Effect.succeed(graph),
    getEvents: () => Effect.succeed([]),
    commit: (command) =>
      Effect.gen(function* () {
        yield* beforeCommit(command)
        expect(command.expectedRevision).toBe(current.revision)
        commits = Array.append(commits, command)
        current = {
          ...current,
          status: command.status,
          snapshot: command.snapshot,
          revision: current.revision + 1,
          updatedAt: command.updatedAt,
        }
        return {
          commitId: command.commitId,
          runId,
          revision: current.revision,
          firstSequence: 1,
          eventCount: command.events.length,
        }
      }),
  }
  const definition = { workflowId: 'managed-test', version, graph, program: Effect.succeed(program) }
  const executor = (afterCommit: typeof LifecycleHook.Service = { afterCommit: () => Effect.void }) =>
    makeManagedExecutor(definition).pipe(
      Effect.provideService(Store, store),
      Effect.provideService(LifecycleHook, afterCommit),
      Effect.provide(BrowserCrypto.layer),
    )
  return {
    restore: () => restoreManagedSnapshot({ ...definition, decode: program.decode, status }, current),
    executor,
    resourceInitialized,
    resourceCalled,
    resourceReleased,
    external,
    started,
    resumed,
    current: () => current,
    commits: () => commits,
    replace: (run: Run) => {
      current = run
    },
    setTransportFailure: () => {
      transportFailure = true
    },
    setBusinessFailure: () => {
      businessFailure = true
    },
    setInvalidPhase: () => {
      invalidPhase = true
    },
    setFinish: (value: boolean) => {
      finish = value
    },
    beforeCommit: (callback: typeof beforeCommit) => {
      beforeCommit = callback
    },
  }
}

describe('request-scoped managed native runtime', () => {
  it('automatically reaches waiting, then resumes in a new runtime and ACKs final state once', async () => {
    const harness = makeHarness()
    const first = await Effect.runPromise(harness.executor())
    await Effect.runPromise(first.start(runId))
    expect(harness.current().status).toBe('waiting')
    expect(harness.external.mock.calls).toEqual([['A']])
    expect(harness.commits()).toHaveLength(2)
    const replacement = await Effect.runPromise(harness.executor())
    await Effect.runPromise(replacement.resume(runId))
    expect(harness.current().status).toBe('completed')
    expect(harness.external.mock.calls).toEqual([['A'], ['B']])
    expect(harness.started).toHaveBeenCalledTimes(1)
    expect(harness.resumed).toHaveBeenCalledTimes(1)
    expect(harness.commits()).toHaveLength(4)
    expect(
      Array.filter(
        Array.flatMap(harness.commits(), (commit) => commit.events),
        (event) => event.type === 'run.resumed',
      ),
    ).toHaveLength(1)
  })

  it('does not call external effects until the checkpoint commit ACK', async () => {
    const harness = makeHarness()
    const ack = Deferred.makeUnsafe<void>()
    const saving = Deferred.makeUnsafe<void>()
    harness.beforeCommit(() => Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(ack))))
    const executor = await Effect.runPromise(harness.executor())
    const pending = Effect.runPromise(executor.start(runId))
    await Effect.runPromise(Deferred.await(saving))
    expect(harness.external).not.toHaveBeenCalled()
    await Effect.runPromise(Deferred.succeed(ack, undefined))
    await pending
    expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
  })

  it('does not return a final response before the final boundary commit ACK', async () => {
    const harness = makeHarness()
    const executor = await Effect.runPromise(harness.executor())
    await Effect.runPromise(executor.start(runId))
    const ack = Deferred.makeUnsafe<void>()
    const saving = Deferred.makeUnsafe<void>()
    harness.beforeCommit((command) =>
      command.status === 'completed'
        ? Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(ack)))
        : Effect.void,
    )
    let replied = false
    const pending = Effect.runPromise(
      executor.resume(runId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            replied = true
          }),
        ),
      ),
    )
    await Effect.runPromise(Deferred.await(saving))
    expect(replied).toBe(false)
    expect(harness.current().status).toBe('running')
    expect(harness.commits()).toHaveLength(3)
    await Effect.runPromise(Deferred.succeed(ack, undefined))
    await pending
    expect(replied).toBe(true)
    expect(harness.current().status).toBe('completed')
    expect(harness.commits()).toHaveLength(4)
  })

  it('propagates the original checkpoint failure without a business failure or external submission', async () => {
    const harness = makeHarness()
    harness.beforeCommit(() => Effect.fail(unavailable))
    const executor = await Effect.runPromise(harness.executor())
    const result = await Effect.runPromise(executor.start(runId).pipe(Effect.exit))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(unavailable)
    expect(harness.external).not.toHaveBeenCalled()
    expect(harness.current().status).toBe('pending')
    expect(harness.commits()).toHaveLength(0)
  })

  it('waits for the boundary ACK and can restore an earlier committed intent after boundary failure', async () => {
    const harness = makeHarness()
    harness.beforeCommit((command) => (command.status === 'waiting' ? Effect.fail(unavailable) : Effect.void))
    const first = await Effect.runPromise(harness.executor())
    const result = await Effect.runPromise(first.start(runId).pipe(Effect.exit))
    expect(Exit.isFailure(result)).toBe(true)
    expect(harness.current().status).toBe('running')
    expect(harness.commits()).toHaveLength(1)
    harness.beforeCommit(() => Effect.void)
    const replacement = await Effect.runPromise(harness.executor())
    await Effect.runPromise(replacement.start(runId))
    expect(harness.current().status).toBe('waiting')
    expect(harness.commits()).toHaveLength(2)
    expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
    expect(
      Array.filter(
        Array.flatMap(harness.commits(), (commit) => commit.events),
        (event) => event.type === 'node.started',
      ),
    ).toHaveLength(1)
  })

  it('does not write revisions or events for unchanged polls and does not approve waiting on start', async () => {
    const harness = makeHarness()
    const first = await Effect.runPromise(harness.executor())
    await Effect.runPromise(first.start(runId))
    harness.setFinish(false)
    const revision = harness.current().revision
    const replacement = await Effect.runPromise(harness.executor())
    await Effect.runPromise(replacement.start(runId))
    await Effect.runPromise(replacement.resume(runId))
    expect(harness.current().revision).toBe(revision)
    expect(harness.external.mock.calls).toEqual([['A']])
    expect(harness.commits()).toHaveLength(2)
  })

  it('rejects mismatched graph, version, status and malformed native state before opening the runtime', async () => {
    const harness = makeHarness()
    const original = harness.current()
    const executor = await Effect.runPromise(harness.executor())
    const invalidRuns: ReadonlyArray<Run> = [
      { ...original, graphId: 'different' },
      { ...original, workflowVersion: decodeVersion('2.0.0') },
      { ...original, status: 'waiting' satisfies RunStatus },
      { ...original, snapshot: { schemaVersion: 1, version: '1.0.0', machine: { invalid: true } } },
    ]
    await Effect.forEach(invalidRuns, (run) =>
      Effect.gen(function* () {
        harness.replace(run)
        const result = yield* executor.start(runId).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }),
    ).pipe(Effect.runPromise)
    expect(harness.started).not.toHaveBeenCalled()
    expect(harness.resumed).not.toHaveBeenCalled()
    expect(harness.external).not.toHaveBeenCalled()
  })

  it('persists different native checkpoints within one node without another node start', async () => {
    const harness = makeHarness(true)
    const executor = await Effect.runPromise(harness.executor())
    await Effect.runPromise(executor.start(runId))
    expect(Array.map(harness.commits(), (commit) => commit.status)).toEqual(['running', 'running', 'waiting'])
    expect(harness.external.mock.calls).toEqual([['A'], ['A phase 2']])
    expect(
      Array.filter(
        Array.flatMap(harness.commits(), (commit) => commit.events),
        (event) => event.type === 'node.started',
      ),
    ).toHaveLength(1)
    expect(harness.current().snapshot).not.toHaveProperty('context')
    expect(harness.current().snapshot).not.toHaveProperty('state')
  })

  it('shares one volatile resource across nodes until ACK and recreates it for the next execution', async () => {
    const harness = makeHarness(true)
    const executor = await Effect.runPromise(harness.executor())
    await Effect.runPromise(executor.start(runId))
    expect(harness.resourceInitialized).toHaveBeenCalledTimes(1)
    expect(harness.resourceCalled).toHaveBeenCalledTimes(2)
    expect(harness.resourceCalled.mock.calls[0]?.[0]).toBe(harness.resourceCalled.mock.calls[1]?.[0])
    expect(harness.resourceReleased).toHaveBeenCalledTimes(1)
    await Effect.runPromise(executor.resume(runId))
    expect(harness.resourceInitialized).toHaveBeenCalledTimes(2)
    expect(harness.resourceCalled).toHaveBeenCalledTimes(3)
    expect(harness.resourceCalled.mock.calls[2]?.[0]).not.toBe(harness.resourceCalled.mock.calls[0]?.[0])
    expect(harness.resourceReleased).toHaveBeenCalledTimes(2)
  })

  it('preserves a native defect as the cause of an infrastructure failure', async () => {
    const harness = makeHarness()
    const defect = new Error('defective persistence')
    harness.beforeCommit(() => Effect.die(defect))
    const executor = await Effect.runPromise(harness.executor())
    const result = await Effect.runPromise(executor.start(runId).pipe(Effect.exit))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause)
      expect(failure).toBeInstanceOf(ExternalError)
      if (failure instanceof ExternalError) expect(failure.cause).toBe(defect)
    }
    expect(harness.external).not.toHaveBeenCalled()
    expect(harness.commits()).toHaveLength(0)
  })

  it('propagates transport failure from a native invoke without changing the waiting checkpoint', async () => {
    const harness = makeHarness()
    const executor = await Effect.runPromise(harness.executor())
    await Effect.runPromise(executor.start(runId))
    const waiting = harness.current()
    harness.setTransportFailure()
    const result = await Effect.runPromise(executor.resume(runId).pipe(Effect.exit))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(unavailable)
    expect(harness.current()).toEqual(waiting)
    expect(harness.commits()).toHaveLength(2)
    expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
  })

  it('fails a later checkpoint before its external submission without committing business failure', async () => {
    const harness = makeHarness(true)
    harness.beforeCommit((command) => (command.events.length === 0 ? Effect.fail(unavailable) : Effect.void))
    const executor = await Effect.runPromise(harness.executor())
    const result = await Effect.runPromise(executor.start(runId).pipe(Effect.exit))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(unavailable)
    expect(harness.current().status).toBe('running')
    expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
    expect(Array.flatMap(harness.commits(), (command) => Array.map(command.events, (event) => event.type))).toEqual([
      'run.started',
      'node.started',
    ])
  })

  it('validates native task state construction before checkpointing or submitting the next effect', async () => {
    const harness = makeHarness(true)
    harness.setInvalidPhase()
    const executor = await Effect.runPromise(harness.executor())
    const result = await Effect.runPromise(executor.start(runId).pipe(Effect.exit))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(InvalidSnapshot)
    expect(harness.commits()).toHaveLength(1)
    expect(harness.current().status).toBe('running')
    expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
  })

  it('commits explicit native business failure and isolates defective post-ACK hooks', async () => {
    const harness = makeHarness()
    harness.setBusinessFailure()
    const executor = await Effect.runPromise(harness.executor({ afterCommit: () => Effect.die('observer failed') }))
    await Effect.runPromise(executor.start(runId))
    expect(harness.current().status).toBe('failed')
    expect(Array.flatMap(harness.commits(), (command) => Array.map(command.events, (event) => event.type))).toEqual([
      'run.started',
      'node.started',
      'node.failed',
      'run.failed',
    ])
  })

  it('restores a native checkpoint without Store, Crypto, or provider runtime dependencies', async () => {
    const harness = makeHarness()
    const restored = await Effect.runPromise(harness.restore())
    expect(restored).toBeDefined()
    expect(harness.started).not.toHaveBeenCalled()
    expect(harness.resumed).not.toHaveBeenCalled()
    expect(harness.external).not.toHaveBeenCalled()
  })

  it('serializes concurrent commands for the same run and ignores defective post-ACK hooks', async () => {
    const harness = makeHarness()
    const executor = await Effect.runPromise(harness.executor({ afterCommit: () => Effect.die('broken observer') }))
    await Effect.runPromise(Effect.all([executor.start(runId), executor.start(runId)], { concurrency: 'unbounded' }))
    expect(harness.current().status).toBe('waiting')
    expect(harness.external.mock.calls).toEqual([['A']])
    expect(harness.commits()).toHaveLength(2)
  })
})
