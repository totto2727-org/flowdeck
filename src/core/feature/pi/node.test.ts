import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { Data, Effect } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

import { WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'
import { ResourceStore } from '@/core/feature/workflow/resource-store'

import { makePiNodeEffects, piNodeEvent } from './node.ts'
import type { PiExecution, PiOutcome } from './node.ts'
import { PiSandbox } from './sandbox.ts'

const execution: PiExecution = {
  attempt: 1,
  commandId: 'command_00000000-0000-4000-8000-000000000002',
  executionId: 'execution_00000000-0000-4000-8000-000000000001',
}
const runId = 'run_00000000-0000-4000-8000-000000000003'
const outcomes = Data.taggedEnum<PiOutcome>()
// oxlint-disable-next-line unicorn/no-null -- The native Pi sandbox uses null for authoritative absence.
const absentTurn = null

describe('shared Pi node effects', () => {
  live('submits a generic turn without selecting workflow nodes or emitting business checkpoints', () =>
    Effect.gen(function* () {
      const checkpoint = vi.fn<WorkflowCheckpoint['Service']['checkpoint']>(() => Effect.void)
      const submitTurn = vi.fn<PiSandbox['Service']['submitTurn']>(() =>
        Effect.succeed({ commandId: execution.commandId, status: 'running' }),
      )
      const result = yield* Effect.gen(function* () {
        const effects = yield* makePiNodeEffects
        return yield* effects.submit({ execution, prompt: 'Perform an arbitrary task.' })
      }).pipe(
        Effect.provideService(PiSandbox, {
          complete: () => Effect.succeed({ model: 'test', sessionId: '1', status: 'completed' }),
          ensureSession: () => Effect.succeed({ model: 'test', sessionId: '1', status: 'active' }),
          getTurn: () => Effect.succeed(absentTurn),
          submitTurn,
        }),
        Effect.provideService(WorkflowCheckpoint, { checkpoint, fail: Effect.die, runId }),
        Effect.provide(ResourceStore.layer),
        Effect.provide(BrowserCrypto.layer),
        Effect.scoped,
      )
      expect(result).toStrictEqual(outcomes.Waiting())
      expect(checkpoint).not.toHaveBeenCalled()
      expect(submitTurn).toHaveBeenCalledExactlyOnceWith(runId, {
        commandId: execution.commandId,
        prompt: 'Perform an arbitrary task.',
      })
    }),
  )

  test('preserves caller-owned node identity in event drafts', () => {
    expect(
      piNodeEvent({ execution, nodeId: 'review-release', payload: { output: 'ready' }, type: 'node.succeeded' }),
    ).toStrictEqual({
      attempt: 1,
      executionId: execution.executionId,
      nodeId: 'review-release',
      payload: { output: 'ready' },
      type: 'node.succeeded',
    })
  })
})
