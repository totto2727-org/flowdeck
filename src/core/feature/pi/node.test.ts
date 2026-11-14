import { BrowserCrypto } from '@effect/platform-browser'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'
import { ResourceStore } from '@/core/feature/workflow/resource-store'

import { makePiNodeEffects, piNodeEvent, type PiExecution } from './node'
import { PiSandbox } from './sandbox'

const execution: PiExecution = {
  executionId: 'execution_00000000-0000-4000-8000-000000000001',
  commandId: 'command_00000000-0000-4000-8000-000000000002',
  attempt: 1,
}
const runId = 'run_00000000-0000-4000-8000-000000000003'

describe('shared Pi node effects', () => {
  it('submits a generic turn without selecting workflow nodes or emitting business checkpoints', async () => {
    const checkpoint = vi.fn(() => Effect.void)
    const submitTurn = vi.fn<PiSandbox['Service']['submitTurn']>(() =>
      Effect.succeed({ commandId: execution.commandId, status: 'running' }),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const effects = yield* makePiNodeEffects
        return yield* effects.submit({ execution, prompt: 'Perform an arbitrary task.' })
      }).pipe(
        Effect.provideService(PiSandbox, {
          ensureSession: () => Effect.succeed({ sessionId: '1', model: 'test', status: 'active' }),
          submitTurn,
          getTurn: () => Effect.succeed(null),
          complete: () => Effect.succeed({ sessionId: '1', model: 'test', status: 'completed' }),
        }),
        Effect.provideService(WorkflowCheckpoint, { runId, checkpoint, fail: Effect.die }),
        Effect.provide(ResourceStore.layer),
        Effect.provide(BrowserCrypto.layer),
        Effect.scoped,
      ),
    )
    expect(result).toEqual({ _tag: 'Waiting' })
    expect(checkpoint).not.toHaveBeenCalled()
    expect(submitTurn).toHaveBeenCalledExactlyOnceWith(runId, {
      commandId: execution.commandId,
      prompt: 'Perform an arbitrary task.',
    })
  })

  it('preserves caller-owned node identity in event drafts', () => {
    expect(piNodeEvent('review-release', execution, 'node.succeeded', { output: 'ready' })).toEqual({
      type: 'node.succeeded',
      nodeId: 'review-release',
      executionId: execution.executionId,
      attempt: 1,
      payload: { output: 'ready' },
    })
  })
})
