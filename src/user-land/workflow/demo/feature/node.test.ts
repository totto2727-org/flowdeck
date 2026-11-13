import { BrowserCrypto } from '@effect/platform-browser'
import { Machine } from '@typeonce/effect-machine'
import { Array, Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { type EventDraft, resumeEvent, WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'

import { demoBoundaryEvents } from './node'
import { demoVersion1Machine, demoVersion1States } from './version-1'
import { demoVersion2Machine, demoVersion2States } from './version-2'

const implementations = [
  { native: demoVersion1Machine, states: demoVersion1States, draft: 'draft:v1' },
  { native: demoVersion2Machine, states: demoVersion2States, draft: 'draft:v2:reviewed' },
]

describe('native demo execution', () => {
  it.each(
    Array.flatMap(implementations, (implementation) =>
      Array.map(['prepare', 'publish'] as const, (phase) => ({ ...implementation, phase })),
    ),
  )(
    'retains the committed $phase execution ID when its invoke is restored: $draft',
    async ({ native, states, draft, phase }) => {
      const prepareExecutionId = 'execution_00000000-0000-4000-8000-000000000001'
      const approvalExecutionId = 'execution_00000000-0000-4000-8000-000000000002'
      const publishExecutionId = 'execution_00000000-0000-4000-8000-000000000003'
      let events: ReadonlyArray<EventDraft> = []
      const checkpoint: typeof WorkflowCheckpoint.Service = {
        runId: 'run_00000000-0000-4000-8000-000000000001',
        fail: Effect.die,
        checkpoint: (drafts) =>
          Effect.sync(() => {
            events = Array.appendAll(events, drafts)
          }),
      }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const value =
              phase === 'prepare'
                ? { _tag: phase, prepareExecutionId }
                : { _tag: phase, prepareExecutionId, approvalExecutionId, publishExecutionId, prepared: draft }
            const state = yield* Machine.decodeSnapshot(native, {
              _tag: 'MachineSnapshot',
              version: 2,
              active: [{ path: '' }, { path: phase, value }],
            })
            const ref = yield* Machine.resume(native, state)
            const boundary = yield* Machine.waitFor(ref, ({ state }) =>
              states.matches(state, phase === 'prepare' ? 'approval' : 'completed'),
            )
            const executionId = phase === 'prepare' ? prepareExecutionId : publishExecutionId
            expect(events).toContainEqual({ type: 'node.started', nodeId: phase, executionId, attempt: 1, payload: {} })
            const stored =
              phase === 'prepare'
                ? Option.getOrThrow(states.get(boundary.state, 'approval'))
                : Option.getOrThrow(states.get(boundary.state, 'completed'))
            expect(stored.prepareExecutionId).toBe(prepareExecutionId)
            if (phase === 'publish')
              expect(stored).toMatchObject({ approvalExecutionId, publishExecutionId, result: `published:${draft}` })
          }),
        ).pipe(Effect.provideService(WorkflowCheckpoint, checkpoint), Effect.provide(BrowserCrypto.layer)),
      )
    },
  )
  it.each(implementations)(
    'waits for approval and preserves execution identities after runtime replacement: $draft',
    async ({ native, states, draft }) => {
      let checkpoints: ReadonlyArray<EventDraft> = []
      const checkpoint: typeof WorkflowCheckpoint.Service = {
        runId: 'run_00000000-0000-4000-8000-000000000001',
        fail: Effect.die,
        checkpoint: (events) =>
          Effect.sync(() => {
            checkpoints = Array.appendAll(checkpoints, events)
          }),
      }
      const program = Effect.gen(function* () {
        const waiting = yield* Effect.scoped(
          Effect.gen(function* () {
            const ref = yield* Machine.start(native)
            const boundary = yield* Machine.waitFor(ref, ({ state }) => states.matches(state, 'approval'))
            const data = Option.getOrThrow(states.get(boundary.state, 'approval'))
            expect(data.prepared).toBe(draft)
            expect(checkpoints).toEqual([
              { type: 'run.started', payload: {} },
              {
                type: 'node.started',
                nodeId: 'prepare',
                executionId: data.prepareExecutionId,
                attempt: 1,
                payload: {},
              },
            ])
            expect(demoBoundaryEvents(boundary.state)).toEqual([
              {
                type: 'node.succeeded',
                nodeId: 'prepare',
                executionId: data.prepareExecutionId,
                attempt: 1,
                payload: { output: draft },
              },
              {
                type: 'node.started',
                nodeId: 'approval',
                executionId: data.approvalExecutionId,
                attempt: 1,
                payload: {},
              },
              {
                type: 'run.waiting',
                nodeId: 'approval',
                executionId: data.approvalExecutionId,
                attempt: 1,
                payload: {},
              },
            ])
            return { encoded: yield* Machine.encodeSnapshot(native, boundary.state), data }
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* Machine.decodeSnapshot(native, waiting.encoded)
            const ref = yield* Machine.resume(native, state)
            expect(states.matches(yield* ref.state, 'approval')).toBe(true)
            expect(checkpoints).toHaveLength(2)
            yield* ref.send(resumeEvent)
            const completed = yield* Machine.waitFor(ref, ({ state }) => states.matches(state, 'completed'))
            const result = Option.getOrThrow(states.get(completed.state, 'completed'))
            expect(result).toMatchObject({ ...waiting.data, _tag: 'completed', result: `published:${draft}` })
            expect(checkpoints).toEqual([
              { type: 'run.started', payload: {} },
              {
                type: 'node.started',
                nodeId: 'prepare',
                executionId: waiting.data.prepareExecutionId,
                attempt: 1,
                payload: {},
              },
              {
                type: 'node.succeeded',
                nodeId: 'approval',
                executionId: waiting.data.approvalExecutionId,
                attempt: 1,
                payload: { approved: true },
              },
              {
                type: 'node.started',
                nodeId: 'publish',
                executionId: result.publishExecutionId,
                attempt: 1,
                payload: {},
              },
            ])
            expect(demoBoundaryEvents(completed.state)).toEqual([
              {
                type: 'node.succeeded',
                nodeId: 'publish',
                executionId: result.publishExecutionId,
                attempt: 1,
                payload: { output: `published:${draft}` },
              },
              { type: 'run.completed', payload: {} },
            ])
          }),
        )
      }).pipe(Effect.provideService(WorkflowCheckpoint, checkpoint), Effect.provide(BrowserCrypto.layer))
      await Effect.runPromise(program)
    },
  )
})
