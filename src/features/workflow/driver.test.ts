import { BrowserCrypto } from '@effect/platform-browser'
import { Array, DateTime, Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { ExternalError } from '@/features/workflow/domain/errors'
import type { Run } from '@/features/workflow/domain/model'
import { Store, type CommitCommand, type StoreService } from '@/features/workflow/services/store'
import { initialDemoContext, type DemoContext } from '@/workers/demo-workflow/features/node'
import { demoVersion1Definition } from '@/workers/demo-workflow/features/version-1'

import {
  encodeMachineSnapshot,
  initialMachineSnapshot,
  LifecycleHook,
  makeDefinition,
  makeDriver,
  TaskExecution,
  taskResult,
  type Task,
} from './driver'

const outcomes = taskResult<DemoContext>()
const external = new ExternalError({ kind: 'storage', operation: 'injected commit failure', cause: 'offline' })
const makeHarness = (task: Task<DemoContext>, rejectCheckpoint = false) => {
  const definition = makeDefinition({ ...demoVersion1Definition, tasks: Effect.succeed({ prepare: task }) })
  let current: Run = {
    runId: 'run_00000000-0000-4000-8000-000000000001',
    workflowId: 'demo',
    workflowVersion: definition.version,
    graphId: definition.machine.graph.graphId,
    status: 'pending',
    revision: 0,
    snapshot: encodeMachineSnapshot(initialMachineSnapshot(definition, initialDemoContext)),
    createdAt: DateTime.makeUnsafe('2026-11-01T00:00:00Z'),
    updatedAt: DateTime.makeUnsafe('2026-11-01T00:00:00Z'),
  }
  let commits: ReadonlyArray<CommitCommand> = []
  const store: StoreService = {
    create: () => Effect.void,
    listRuns: Effect.sync(() => [current]),
    getRun: () => Effect.sync(() => current),
    getGraph: () => Effect.succeed(definition.machine.graph),
    getEvents: () => Effect.succeed([]),
    commit: (command) =>
      Effect.gen(function* () {
        if (rejectCheckpoint && command.events.length === 0) return yield* Effect.fail(external)
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
          runId: current.runId,
          revision: current.revision,
          firstSequence: 1,
          eventCount: command.events.length,
        }
      }),
  }
  const run = (operation: 'start' | 'resume', hook = { afterCommit: () => Effect.void }) =>
    Effect.runPromise(
      makeDriver(definition).pipe(
        Effect.flatMap((driver) => driver[operation](current.runId)),
        Effect.provideService(Store, store),
        Effect.provideService(LifecycleHook, hook),
        Effect.provide(BrowserCrypto.layer),
      ),
    )
  return { run, current: () => current, commits: () => commits }
}

describe('durable Effect task driver', () => {
  it('does not execute a task before its start checkpoint ACK', async () => {
    const execute = vi.fn((context: DemoContext) => Effect.succeed(outcomes.Wait({ context })))
    const harness = makeHarness({ execute })
    let observed: ReadonlyArray<{ revision: number; taskCalls: number }> = []
    const hook = {
      afterCommit: () =>
        Effect.sync(() => {
          observed = Array.append(observed, {
            revision: harness.current().revision,
            taskCalls: execute.mock.calls.length,
          })
        }),
    }
    await harness.run('start', hook)
    expect(observed).toEqual([
      { revision: 1, taskCalls: 0 },
      { revision: 2, taskCalls: 1 },
    ])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(harness.current().status).toBe('waiting')
  })
  it('does not write resume/start events or revision for an unchanged poll after runtime replacement', async () => {
    const harness = makeHarness({
      execute: (context) =>
        Effect.gen(function* () {
          const control = yield* TaskExecution
          return control.operation === 'resume' ? outcomes.Unchanged() : outcomes.Wait({ context })
        }),
    })
    await harness.run('start')
    const waiting = harness.current()
    await harness.run('start')
    await harness.run('resume')
    expect(harness.current()).toEqual(waiting)
    expect(harness.commits()).toHaveLength(2)
  })
  it('propagates transport failure without turning a waiting task into business failure', async () => {
    const harness = makeHarness({
      execute: (context) =>
        Effect.gen(function* () {
          const control = yield* TaskExecution
          if (control.operation === 'resume') return yield* Effect.fail(external)
          return outcomes.Wait({ context })
        }),
    })
    await harness.run('start')
    const waiting = harness.current()
    await expect(harness.run('resume')).rejects.toMatchObject({ _tag: 'ExternalError' })
    expect(harness.current()).toEqual(waiting)
    expect(harness.commits()).toHaveLength(2)
  })
  it('propagates intra-task checkpoint failure before external submission and never commits Failed', async () => {
    const submit = vi.fn()
    const harness = makeHarness(
      {
        execute: (context) =>
          Effect.gen(function* () {
            const control = yield* TaskExecution
            yield* control.checkpoint({ ...context, prepared: 'intent' })
            yield* Effect.sync(submit)
            return outcomes.Wait({ context })
          }),
      },
      true,
    )
    await expect(harness.run('start')).rejects.toMatchObject({ _tag: 'ExternalError' })
    expect(submit).not.toHaveBeenCalled()
    expect(harness.current().status).toBe('running')
    expect(Array.flatMap(harness.commits(), (commit) => Array.map(commit.events, (event) => event.type))).toEqual([
      'run.started',
      'node.started',
    ])
  })
  it('restores an acknowledged task checkpoint without duplicating its start after transport failure', async () => {
    const submit = vi.fn()
    const harness = makeHarness({
      execute: (context) =>
        Effect.gen(function* () {
          const control = yield* TaskExecution
          if (context.prepared === 'intent') return outcomes.Wait({ context })
          yield* control.checkpoint({ ...context, prepared: 'intent' })
          yield* Effect.sync(submit)
          return yield* Effect.fail(external)
        }),
    })
    await expect(harness.run('start')).rejects.toMatchObject({ _tag: 'ExternalError' })
    expect(harness.current().status).toBe('running')
    expect(harness.current().revision).toBe(2)
    await harness.run('start')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(harness.current().status).toBe('waiting')
    expect(harness.current().revision).toBe(3)
    expect(Array.flatMap(harness.commits(), (commit) => Array.map(commit.events, (event) => event.type))).toEqual([
      'run.started',
      'node.started',
      'run.waiting',
    ])
  })
  it('validates unknown task checkpoints before committing or submitting effects', async () => {
    const submit = vi.fn()
    const harness = makeHarness({
      execute: (context) =>
        Effect.gen(function* () {
          const execution = yield* TaskExecution
          yield* execution.checkpoint({ prepared: 42, result: '' })
          yield* Effect.sync(submit)
          return outcomes.Wait({ context })
        }),
    })
    await expect(harness.run('start')).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
    expect(submit).not.toHaveBeenCalled()
    expect(harness.commits()).toHaveLength(1)
    expect(harness.current().status).toBe('running')
  })
  it('commits explicit business failure and isolates a defective post-ACK observer', async () => {
    const harness = makeHarness({
      execute: (context) =>
        Effect.succeed(outcomes.Fail({ context, message: 'invalid task', payload: { reason: 'invalid' } })),
    })
    await harness.run('start', { afterCommit: () => Effect.die('observer failed') })
    expect(harness.current().status).toBe('failed')
    expect(Array.flatMap(harness.commits(), (commit) => Array.map(commit.events, (event) => event.type))).toEqual([
      'run.started',
      'node.started',
      'node.failed',
      'run.failed',
    ])
  })
})
