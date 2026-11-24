import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { Array, Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, HashSet, Ref, Schema, SemVer } from 'effect'
import { describe, expect, vi } from 'vite-plus/test'

import { ExternalError, InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import type { GraphDefinition, Run, RunStatus } from '@/core/feature/workflow/domain/model'
import { LifecycleHook } from '@/core/feature/workflow/lifecycle'
import type { EventDraft } from '@/core/feature/workflow/lifecycle'
import { ResourceStore } from '@/core/feature/workflow/resource-store'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'
import { Store } from '@/core/feature/workflow/services/store'
import type { CommitCommand, StoreFailure, StoreService } from '@/core/feature/workflow/services/store'

import {
  encodeManagedSnapshot,
  makeManagedExecutor,
  restoreManagedSnapshot,
  ResumeEvent,
  WorkflowCheckpoint,
} from './managed-runtime.ts'

const version = SemVer.parseUnsafe('1.0.0')
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The machine's native encoder returns a raw wire value.
const decodeJson = Schema.decodeUnknownEffect(Schema.JsonObject)
const runId = 'run_00000000-0000-4000-8000-000000000001'
const executionId = 'execution_00000000-0000-4000-8000-000000000001'
const unavailable = new ExternalError({ kind: 'storage', operation: 'test commit', cause: 'offline' })
const graph: GraphDefinition = { graphId: 'managed-test-1', schemaVersion: 1, nodes: [], edges: [] }

class NativeResource extends Context.Service<NativeResource, Readonly<{ call: () => void }>>()('test/NativeResource') {}

const makeHarness = Effect.fn(function* (multipleCheckpoints = false) {
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
  const effect = (
    name: string,
    drafts: Readonly<EventDraft[]>,
  ): Effect.Effect<void, never, WorkflowCheckpoint | ResourceStore> =>
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
        if (transportFailure) {
          return yield* checkpoint.fail(unavailable)
        }
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
    boundaryEvents: (state: State): Readonly<EventDraft[]> =>
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
  const initial = yield* Machine.planInitial(native)
  const machine = yield* program.encode(initial.state)
  let current: Run = {
    runId,
    workflowId: 'managed-test',
    workflowVersion: version,
    graphId: graph.graphId,
    status: 'pending',
    revision: 0,
    snapshot: encodeManagedSnapshot({ schemaVersion: 1, version, machine }),
    createdAt: DateTime.makeUnsafe('2026-11-01T00:00:00Z'),
    updatedAt: DateTime.makeUnsafe('2026-11-01T00:00:00Z'),
  }
  let commits: Readonly<CommitCommand[]> = []
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
})

describe('request-scoped managed native runtime', () => {
  live('automatically reaches waiting, then resumes in a new runtime and ACKs final state once', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const first = yield* harness.executor()
      yield* first.start(runId)
      expect(harness.current().status).toBe('waiting')
      expect(harness.external.mock.calls).toStrictEqual([['A']])
      expect(harness.commits()).toHaveLength(2)
      const replacement = yield* harness.executor()
      yield* replacement.resume(runId)
      expect(harness.current().status).toBe('completed')
      expect(harness.external.mock.calls).toStrictEqual([['A'], ['B']])
      expect(harness.started).toHaveBeenCalledOnce()
      expect(harness.resumed).toHaveBeenCalledOnce()
      expect(harness.commits()).toHaveLength(4)
      expect(
        Array.filter(
          Array.flatMap(harness.commits(), (commit) => commit.events),
          (event) => event.type === 'run.resumed',
        ),
      ).toHaveLength(1)
    }),
  )

  live('does not call external effects until the checkpoint commit ACK', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const ack = yield* Deferred.make<true>()
      const saving = yield* Deferred.make<true>()
      harness.beforeCommit(() =>
        Deferred.succeed(saving, true).pipe(Effect.andThen(Deferred.await(ack)), Effect.asVoid),
      )
      const executor = yield* harness.executor()
      const pending = yield* Effect.forkScoped(executor.start(runId))
      yield* Deferred.await(saving)
      expect(harness.external).not.toHaveBeenCalled()
      yield* Deferred.succeed(ack, true)
      yield* Fiber.join(pending)
      expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
    }),
  )

  live('does not return a final response before the final boundary commit ACK', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const executor = yield* harness.executor()
      yield* executor.start(runId)
      const ack = yield* Deferred.make<true>()
      const saving = yield* Deferred.make<true>()
      harness.beforeCommit((command) =>
        command.status === 'completed'
          ? Deferred.succeed(saving, true).pipe(Effect.andThen(Deferred.await(ack)), Effect.asVoid)
          : Effect.void,
      )
      const replied = yield* Ref.make(false)
      const command = executor.resume(runId).pipe(Effect.tap(() => Ref.set(replied, true)))
      const pending = yield* Effect.forkScoped(command)
      yield* Deferred.await(saving)
      expect(yield* Ref.get(replied)).toBe(false)
      expect(harness.current().status).toBe('running')
      expect(harness.commits()).toHaveLength(3)
      yield* Deferred.succeed(ack, true)
      yield* Fiber.join(pending)
      expect(yield* Ref.get(replied)).toBe(true)
      expect(harness.current().status).toBe('completed')
      expect(harness.commits()).toHaveLength(4)
    }),
  )

  live('propagates the original checkpoint failure without a business failure or external submission', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      harness.beforeCommit(() => Effect.fail(unavailable))
      const executor = yield* harness.executor()
      const result = yield* executor.start(runId).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toBe(unavailable)
      }
      expect(harness.external).not.toHaveBeenCalled()
      expect(harness.current().status).toBe('pending')
      expect(harness.commits()).toHaveLength(0)
    }),
  )

  live('waits for the boundary ACK and can restore an earlier committed intent after boundary failure', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      harness.beforeCommit((command) => (command.status === 'waiting' ? Effect.fail(unavailable) : Effect.void))
      const first = yield* harness.executor()
      const result = yield* first.start(runId).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(harness.current().status).toBe('running')
      expect(harness.commits()).toHaveLength(1)
      harness.beforeCommit(() => Effect.void)
      const replacement = yield* harness.executor()
      yield* replacement.start(runId)
      expect(harness.current().status).toBe('waiting')
      expect(harness.commits()).toHaveLength(2)
      expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
      expect(
        Array.filter(
          Array.flatMap(harness.commits(), (commit) => commit.events),
          (event) => event.type === 'node.started',
        ),
      ).toHaveLength(1)
    }),
  )

  live('does not write revisions or events for unchanged polls and does not approve waiting on start', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const first = yield* harness.executor()
      yield* first.start(runId)
      harness.setFinish(false)
      const { revision } = harness.current()
      const replacement = yield* harness.executor()
      yield* replacement.start(runId)
      yield* replacement.resume(runId)
      expect(harness.current().revision).toBe(revision)
      expect(harness.external.mock.calls).toStrictEqual([['A']])
      expect(harness.commits()).toHaveLength(2)
    }),
  )

  live('rejects mismatched graph, version, status and malformed native state before opening the runtime', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const original = harness.current()
      const executor = yield* harness.executor()
      const invalidRuns: Readonly<Run[]> = [
        { ...original, graphId: 'different' },
        { ...original, workflowVersion: SemVer.parseUnsafe('2.0.0') },
        { ...original, status: 'waiting' },
        { ...original, snapshot: { machine: { invalid: true }, schemaVersion: 1, version: '1.0.0' } },
      ]
      yield* Effect.forEach(
        invalidRuns,
        (run) =>
          Effect.gen(function* () {
            harness.replace(run)
            const result = yield* executor.start(runId).pipe(Effect.exit)
            expect(Exit.isFailure(result)).toBe(true)
          }),
        { discard: true },
      )
      expect(harness.started).not.toHaveBeenCalled()
      expect(harness.resumed).not.toHaveBeenCalled()
      expect(harness.external).not.toHaveBeenCalled()
    }),
  )

  live('persists different native checkpoints within one node without another node start', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(true)
      const executor = yield* harness.executor()
      yield* executor.start(runId)
      expect(Array.map(harness.commits(), (commit) => commit.status)).toStrictEqual(['running', 'running', 'waiting'])
      expect(harness.external.mock.calls).toStrictEqual([['A'], ['A phase 2']])
      expect(
        Array.filter(
          Array.flatMap(harness.commits(), (commit) => commit.events),
          (event) => event.type === 'node.started',
        ),
      ).toHaveLength(1)
      expect(harness.current().snapshot).not.toHaveProperty('context')
      expect(harness.current().snapshot).not.toHaveProperty('state')
    }),
  )

  live('shares one volatile resource across nodes until ACK and recreates it for the next execution', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(true)
      const executor = yield* harness.executor()
      yield* executor.start(runId)
      expect(harness.resourceInitialized).toHaveBeenCalledOnce()
      expect(harness.resourceCalled).toHaveBeenCalledTimes(2)
      expect(harness.resourceCalled.mock.calls[0]?.[0]).toBe(harness.resourceCalled.mock.calls[1]?.[0])
      expect(harness.resourceReleased).toHaveBeenCalledOnce()
      yield* executor.resume(runId)
      expect(harness.resourceInitialized).toHaveBeenCalledTimes(2)
      expect(harness.resourceCalled).toHaveBeenCalledTimes(3)
      expect(harness.resourceCalled.mock.calls[2]?.[0]).not.toBe(harness.resourceCalled.mock.calls[0]?.[0])
      expect(harness.resourceReleased).toHaveBeenCalledTimes(2)
    }),
  )

  live('preserves a native defect as the cause of an infrastructure failure', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const defect = new Error('defective persistence')
      harness.beforeCommit(() => Effect.die(defect))
      const executor = yield* harness.executor()
      const result = yield* executor.start(runId).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const failure = Cause.squash(result.cause)
        expect(failure).toBeInstanceOf(ExternalError)
        if (failure instanceof ExternalError) {
          expect(failure.cause).toBe(defect)
        }
      }
      expect(harness.external).not.toHaveBeenCalled()
      expect(harness.commits()).toHaveLength(0)
    }),
  )

  live('propagates transport failure from a native invoke without changing the waiting checkpoint', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const executor = yield* harness.executor()
      yield* executor.start(runId)
      const waiting = harness.current()
      harness.setTransportFailure()
      const result = yield* executor.resume(runId).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toBe(unavailable)
      }
      expect(harness.current()).toStrictEqual(waiting)
      expect(harness.commits()).toHaveLength(2)
      expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
    }),
  )

  live('fails a later checkpoint before its external submission without committing business failure', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(true)
      harness.beforeCommit((command) =>
        Array.isReadonlyArrayEmpty(command.events) ? Effect.fail(unavailable) : Effect.void,
      )
      const executor = yield* harness.executor()
      const result = yield* executor.start(runId).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toBe(unavailable)
      }
      expect(harness.current().status).toBe('running')
      expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
      expect(
        Array.flatMap(harness.commits(), (command) => Array.map(command.events, (event) => event.type)),
      ).toStrictEqual(['run.started', 'node.started'])
    }),
  )

  live('validates native task state construction before checkpointing or submitting the next effect', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(true)
      harness.setInvalidPhase()
      const executor = yield* harness.executor()
      const result = yield* executor.start(runId).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toBeInstanceOf(InvalidSnapshot)
      }
      expect(harness.commits()).toHaveLength(1)
      expect(harness.current().status).toBe('running')
      expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
    }),
  )

  live('commits explicit native business failure and isolates defective post-ACK hooks', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      harness.setBusinessFailure()
      const executor = yield* harness.executor({ afterCommit: () => Effect.die('observer failed') })
      yield* executor.start(runId)
      expect(harness.current().status).toBe('failed')
      expect(
        Array.flatMap(harness.commits(), (command) => Array.map(command.events, (event) => event.type)),
      ).toStrictEqual(['run.started', 'node.started', 'node.failed', 'run.failed'])
    }),
  )

  live('restores a native checkpoint without Store, Crypto, or provider runtime dependencies', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const restored = yield* harness.restore()
      expect(restored).toBeDefined()
      expect(harness.started).not.toHaveBeenCalled()
      expect(harness.resumed).not.toHaveBeenCalled()
      expect(harness.external).not.toHaveBeenCalled()
    }),
  )

  live('serializes concurrent commands for the same run and ignores defective post-ACK hooks', () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const executor = yield* harness.executor({ afterCommit: () => Effect.die('broken observer') })
      yield* Effect.all([executor.start(runId), executor.start(runId)], { concurrency: 'unbounded' })
      expect(harness.current().status).toBe('waiting')
      expect(harness.external.mock.calls).toStrictEqual([['A']])
      expect(harness.commits()).toHaveLength(2)
    }),
  )
})
