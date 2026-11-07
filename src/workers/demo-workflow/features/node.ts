import { DateTime, Effect, type Schema } from 'effect'

import type { UserDefinedId } from '../../../features/identity/id'
import type { ExecutionId, RunId } from '../../../features/workflow/domain/identity'
import type { JsonObject } from '../../../features/workflow/domain/model'
import type { PendingEvent } from '../../../features/workflow/services/store'

export interface Execution {
  readonly runId: RunId
  readonly nodeId: UserDefinedId
  readonly executionId: ExecutionId
  readonly attempt: number
}
type Draft<Event> = Event extends PendingEvent ? Omit<Event, 'createdAt' | 'eventId'> : never
export type EventDraft = Draft<PendingEvent>
export const timestamp = DateTime.now
export const nodeEvent = (
  execution: Execution,
  type: 'node.started' | 'node.succeeded' | 'node.failed',
  payload: JsonObject = {},
): EventDraft => ({
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
export const observeNode = <A extends Schema.Json | void, E, R, E2, R2>(
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
        onSuccess: (output) =>
          hooks.succeeded(nodeEvent(execution, 'node.succeeded', output === undefined ? {} : { output }), output),
      }),
    )
  })
