import { live } from '@effect/vitest'
import { Array, Cause, Deferred, Effect, Exit, Fiber, Ref } from 'effect'
import { expect } from 'vite-plus/test'

import { runId, unavailable } from './managed-runtime-observers.fixture.ts'
import { makeHarness } from './managed-runtime.fixture.ts'

type Harness = Effect.Success<ReturnType<typeof makeHarness>>
const recordedEvents = (fixture: Harness): Readonly<HarnessEvent[]> =>
  Array.flatMap(fixture.commits(), (commit) => commit.events)
type HarnessEvent = ReturnType<Harness['commits']>[number]['events'][number]

const commitGate = Effect.gen(function* () {
  const saved = yield* Deferred.make<true>()
  const acknowledge = yield* Deferred.make<true>()
  return {
    acknowledge: Deferred.succeed(acknowledge, true),
    saved: Deferred.await(saved),
    wait: Deferred.succeed(saved, true).pipe(Effect.andThen(Deferred.await(acknowledge)), Effect.asVoid),
  }
})

live('automatically reaches waiting, then resumes in a new runtime and ACKs final state once', () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness()
    const first = yield* harness.executor()
    yield* first.start(runId)
    expect({
      commits: Array.length(harness.commits()),
      external: harness.external.mock.calls,
      status: harness.current().status,
    }).toStrictEqual({ commits: 2, external: [['A']], status: 'waiting' })
    const replacement = yield* harness.executor()
    yield* replacement.resume(runId)
    const events = recordedEvents(harness)
    expect({
      commits: Array.length(harness.commits()),
      external: harness.external.mock.calls,
      resumeEvents: Array.length(Array.filter(events, (event) => event.type === 'run.resumed')),
      resumed: Array.length(harness.resumed.mock.calls),
      started: Array.length(harness.started.mock.calls),
      status: harness.current().status,
    }).toStrictEqual({
      commits: 4,
      external: [['A'], ['B']],
      resumeEvents: 1,
      resumed: 1,
      started: 1,
      status: 'completed',
    })
  }),
)

live('does not call external effects until the checkpoint commit ACK', () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness()
    const gate = yield* commitGate
    harness.beforeCommit(() => gate.wait)
    const executor = yield* harness.executor()
    const pending = yield* Effect.forkScoped(executor.start(runId))
    yield* gate.saved
    expect(harness.external).not.toHaveBeenCalled()
    yield* gate.acknowledge
    yield* Fiber.join(pending)
    expect(harness.external).toHaveBeenCalledExactlyOnceWith('A')
  }),
)

const startUntilFinalCommit = Effect.fn('flowdeck.test.pauseFinalAck')(function* (
  harness: Harness,
  gate: Effect.Success<typeof commitGate>,
) {
  const executor = yield* harness.executor()
  yield* executor.start(runId)
  harness.beforeCommit((command) => (command.status === 'completed' ? gate.wait : Effect.void))
  const replied = yield* Ref.make(false)
  const command = executor.resume(runId).pipe(Effect.tap(() => Ref.set(replied, true)))
  const pending = yield* Effect.forkScoped(command)
  yield* gate.saved
  return { pending, replied: Ref.get(replied) }
})

live('does not return a final response before the final boundary commit ACK', () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness()
    const gate = yield* commitGate
    const { pending, replied } = yield* startUntilFinalCommit(harness, gate)
    expect({
      commits: Array.length(harness.commits()),
      replied: yield* replied,
      status: harness.current().status,
    }).toStrictEqual({ commits: 3, replied: false, status: 'running' })
    yield* gate.acknowledge
    yield* Fiber.join(pending)
    expect({
      commits: Array.length(harness.commits()),
      replied: yield* replied,
      status: harness.current().status,
    }).toStrictEqual({ commits: 4, replied: true, status: 'completed' })
  }),
)

live('propagates the original checkpoint failure without a business failure or external submission', () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness()
    harness.beforeCommit(() => Effect.fail(unavailable))
    const executor = yield* harness.executor()
    const result = yield* executor.start(runId).pipe(Effect.exit)
    expect(Exit.isFailure(result) ? Cause.squash(result.cause) : undefined).toBe(unavailable)
    expect(harness.external).not.toHaveBeenCalled()
    expect(harness.current().status).toBe('pending')
    expect(harness.commits()).toHaveLength(0)
  }),
)

const pauseWaitingCommit = Effect.fn('flowdeck.test.rejectWaitingCommit')(function* (harness: Harness) {
  harness.beforeCommit((command) => (command.status === 'waiting' ? Effect.fail(unavailable) : Effect.void))
  const first = yield* harness.executor()
  const result = yield* first.start(runId).pipe(Effect.exit)
  harness.beforeCommit(() => Effect.void)
  return result
})

live('waits for the boundary ACK and can restore an earlier committed intent after boundary failure', () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness()
    const result = yield* pauseWaitingCommit(harness)
    expect({
      commits: Array.length(harness.commits()),
      failed: Exit.isFailure(result),
      status: harness.current().status,
    }).toStrictEqual({ commits: 1, failed: true, status: 'running' })
    const replacement = yield* harness.executor()
    yield* replacement.start(runId)
    const events = recordedEvents(harness)
    expect({
      commits: Array.length(harness.commits()),
      external: harness.external.mock.calls,
      nodeStarts: Array.length(Array.filter(events, (event) => event.type === 'node.started')),
      status: harness.current().status,
    }).toStrictEqual({ commits: 2, external: [['A']], nodeStarts: 1, status: 'waiting' })
  }),
)
