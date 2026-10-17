import { DateTime, Effect } from 'effect'

import type { PendingEvent } from '../../../features/workflow/services/store'

export interface Execution {
  readonly runId: string
  readonly nodeId: string
  readonly executionId: string
  readonly attempt: number
}
export type EventDraft = Omit<PendingEvent, 'createdAt'>
export const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso))
export const nodeEvent = (
  execution: Execution,
  type: 'node.started' | 'node.succeeded' | 'node.failed',
  payload: Readonly<Record<string, unknown>> = {},
): EventDraft => ({
  eventId: `${execution.executionId}:${type}`,
  nodeId: execution.nodeId,
  executionId: execution.executionId,
  attempt: execution.attempt,
  type,
  payload,
})

/** A lifecycle wrapper, not a scheduler. Workflow-owned hooks atomically save
 * their typed snapshot together with these node events. A restored node may
 * skip its already committed start hook, then reconnect/retry its own work.
 */
export const observeNode = <A, E, R, E2, R2>(
  execution: Execution,
  task: Effect.Effect<A, E, R>,
  hooks: {
    readonly started: (event: EventDraft) => Effect.Effect<void, E2, R2>
    readonly succeeded: (event: EventDraft, output: A) => Effect.Effect<void, E2, R2>
    readonly failed: (event: EventDraft, error: E) => Effect.Effect<void, E2, R2>
  },
): Effect.Effect<void, E | E2, R | R2> =>
  Effect.gen(function* () {
    yield* hooks.started(nodeEvent(execution, 'node.started'))
    yield* task.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          hooks.failed(nodeEvent(execution, 'node.failed'), error).pipe(Effect.andThen(Effect.fail(error))),
        onSuccess: (output) => hooks.succeeded(nodeEvent(execution, 'node.succeeded', { output }), output),
      }),
    )
  })
