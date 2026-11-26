import { live } from '@effect/vitest'
import { Array, Cause, Effect, Exit, Option, SemVer } from 'effect'
import { expect } from 'vite-plus/test'

import { ExternalError, InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import type { Run } from '@/core/feature/workflow/domain/model'

import { runId, unavailable } from './managed-runtime-observers.fixture.ts'
import { makeHarness } from './managed-runtime.fixture.ts'

type Harness = Effect.Success<ReturnType<typeof makeHarness>>
const failureCause = <A, E>(result: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(result) ? Cause.squash(result.cause) : undefined

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
    expect({
      commits: Array.length(harness.commits()),
      external: harness.external.mock.calls,
      revision: harness.current().revision,
    }).toStrictEqual({ commits: 2, external: [['A']], revision })
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
    const events = Array.flatMap(harness.commits(), (commit) => commit.events)
    expect(Array.filter(events, (event) => event.type === 'node.started')).toHaveLength(1)
    expect(harness.current().snapshot).not.toHaveProperty('context')
    expect(harness.current().snapshot).not.toHaveProperty('state')
  }),
)

type LifetimeCounts = Readonly<{ calls: number; created: number; released: number }>
const lifetimeCounts = (harness: Harness): LifetimeCounts => ({
  calls: Array.length(harness.resourceCalled.mock.calls),
  created: Array.length(harness.resourceInitialized.mock.calls),
  released: Array.length(harness.resourceReleased.mock.calls),
})

live('shares one volatile resource across nodes until ACK and recreates it for the next execution', () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(true)
    const executor = yield* harness.executor()
    yield* executor.start(runId)
    expect(lifetimeCounts(harness)).toStrictEqual({ calls: 2, created: 1, released: 1 })
    const [first, second] = harness.resourceCalled.mock.calls
    expect(first?.[0]).toBe(second?.[0])
    yield* executor.resume(runId)
    expect(lifetimeCounts(harness)).toStrictEqual({ calls: 3, created: 2, released: 2 })
    const verification = Option.getOrUndefined(Array.last(harness.resourceCalled.mock.calls))
    expect(verification?.[0]).not.toBe(first?.[0])
  }),
)

live('preserves a native defect as the cause of an infrastructure failure', () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness()
    // oxlint-disable-next-line rules/require-tagged-error -- The test injects a native persistence defect and checks its object identity.
    const defect = new Error('defective persistence')
    harness.beforeCommit(() => Effect.die(defect))
    const executor = yield* harness.executor()
    const result = yield* executor.start(runId).pipe(Effect.exit)
    const failure = failureCause(result)
    expect(failure).toBeInstanceOf(ExternalError)
    expect(failure).toHaveProperty('cause', defect)
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
    expect(failureCause(result)).toBe(unavailable)
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
    expect(failureCause(result)).toBe(unavailable)
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
    expect(failureCause(result)).toBeInstanceOf(InvalidSnapshot)
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
