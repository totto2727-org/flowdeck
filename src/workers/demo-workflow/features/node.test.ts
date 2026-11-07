import { Array, Effect, Ref } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { type EventDraft, type Execution, observeNode } from './node'

const execution: Execution = {
  runId: 'run_00000000-0000-4000-8000-000000000001',
  nodeId: 'prepare',
  executionId: 'execution_00000000-0000-4000-8000-000000000001',
  attempt: 1,
}

describe('node lifecycle wrapper', () => {
  it('emits a stable start and success identity with typed output', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Ref.make<ReadonlyArray<EventDraft>>([])
        const append = (event: EventDraft) => Ref.update(events, Array.append(event))
        yield* observeNode(execution, Effect.succeed('result'), {
          started: append,
          succeeded: append,
          failed: append,
        })
        return yield* Ref.get(events)
      }),
    )
    expect(result).toEqual([
      {
        type: 'node.started',
        nodeId: 'prepare',
        executionId: 'execution_00000000-0000-4000-8000-000000000001',
        attempt: 1,
        payload: {},
      },
      {
        type: 'node.succeeded',
        nodeId: 'prepare',
        executionId: 'execution_00000000-0000-4000-8000-000000000001',
        attempt: 1,
        payload: { output: 'result' },
      },
    ])
  })

  it('persists a failure event before propagating the original node failure', async () => {
    const events = await Effect.runPromise(Ref.make<ReadonlyArray<EventDraft>>([]))
    const append = (event: EventDraft) => Ref.update(events, Array.append(event))
    await expect(
      Effect.runPromise(
        observeNode(execution, Effect.fail({ _tag: 'NodeFailure' as const, detail: 'unavailable' }), {
          started: append,
          succeeded: append,
          failed: append,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeFailure', detail: 'unavailable' })
    expect(Array.map(await Effect.runPromise(Ref.get(events)), (event) => event.type)).toEqual([
      'node.started',
      'node.failed',
    ])
  })

  it('omits absent output instead of persisting undefined JSON', async () => {
    const events = await Effect.runPromise(Ref.make<ReadonlyArray<EventDraft>>([]))
    const append = (event: EventDraft) => Ref.update(events, Array.append(event))
    await Effect.runPromise(observeNode(execution, Effect.void, { started: append, succeeded: append, failed: append }))
    expect(Array.map(await Effect.runPromise(Ref.get(events)), (event) => event.payload)).toEqual([{}, {}])
  })

  it('does not execute the task before the start checkpoint commits', async () => {
    const executed = await Effect.runPromise(Ref.make(false))
    await expect(
      Effect.runPromise(
        observeNode(execution, Ref.set(executed, true), {
          started: () => Effect.fail({ _tag: 'CommitFailure' as const }),
          succeeded: () => Effect.void,
          failed: () => Effect.void,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'CommitFailure' })
    expect(await Effect.runPromise(Ref.get(executed))).toBe(false)
  })
})
