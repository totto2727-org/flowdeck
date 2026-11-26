import { live } from '@effect/vitest'
import { Effect, Predicate } from 'effect'
import { describe, expect } from 'vite-plus/test'

import {
  approvalCheckpoints,
  completionCheckpoints,
  firstCheckpoints,
  implementations,
  recordedCheckpoints,
  restoredInvokes,
  restoreThroughCompletion,
  resumeCommittedInvoke,
  resumedCheckpoints,
  startUntilApproval,
} from './node-execution.fixture.ts'

const wasCompleted = Predicate.isTagged('completed')

describe('demo native invoke restoration', () => {
  live.each(restoredInvokes)('retains the committed $phase execution identity after restoration: $draft', (restore) =>
    Effect.gen(function* () {
      const { events, result } = yield* resumeCommittedInvoke(restore)
      expect(events).toContainEqual({
        attempt: 1,
        executionId: restore.executionId,
        nodeId: restore.phase,
        payload: {},
        type: 'node.started',
      })
      expect(result).toMatchObject(restore.expected)
      expect(wasCompleted(result)).toBe(restore.next === 'completed')
    }),
  )
})

const observeNativeReplacement = Effect.fn('flowdeck.test.observeDemoRuntimeReplacement')(function* (
  implementation: (typeof implementations)[number],
) {
  const record = yield* recordedCheckpoints
  const waiting = yield* startUntilApproval(implementation).pipe(Effect.scoped, Effect.provide(record.services))
  const initialEvents = yield* record.events
  const resumed = yield* restoreThroughCompletion(implementation, waiting, record).pipe(
    Effect.scoped,
    Effect.provide(record.services),
  )
  return { initialEvents, recorded: yield* record.events, resumed, waiting }
})

describe('demo approval and native runtime replacement', () => {
  live.each(implementations)(
    'waits for approval and preserves execution identities after replacement: $draft',
    (implementation) =>
      Effect.gen(function* () {
        const { initialEvents, recorded, resumed, waiting } = yield* observeNativeReplacement(implementation)
        expect({
          atApproval: resumed.atApproval,
          completed: wasCompleted(resumed.result),
          draft: waiting.data.prepared,
        }).toStrictEqual({ atApproval: true, completed: true, draft: implementation.draft })
        expect({ before: initialEvents, resumed: resumed.beforeResume }).toStrictEqual({
          before: firstCheckpoints(waiting.data),
          resumed: firstCheckpoints(waiting.data),
        })
        expect(waiting.boundary).toStrictEqual(approvalCheckpoints(waiting.data))
        expect(resumed.result).toMatchObject({
          approvalExecutionId: waiting.data.approvalExecutionId,
          prepareExecutionId: waiting.data.prepareExecutionId,
          prepared: waiting.data.prepared,
          result: `published:${implementation.draft}`,
        })
        expect({ recorded, sent: resumed.final }).toStrictEqual({
          recorded: resumedCheckpoints(waiting.data, resumed.result),
          sent: completionCheckpoints(resumed.result),
        })
      }),
  )
})
