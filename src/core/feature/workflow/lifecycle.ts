import { Context, Effect } from 'effect'

import type { CommitAck, PendingEvent } from '@/core/feature/workflow/services/store'

type Draft<Event> = Event extends PendingEvent ? Omit<Event, 'createdAt' | 'eventId'> : never
export type EventDraft = Draft<PendingEvent>

/** Post-ACK observation is best effort. Hooks cannot undo canonical commits. */
export const LifecycleHook = Context.Reference<
  Readonly<{
    afterCommit: (events: Readonly<PendingEvent[]>, ack: CommitAck) => Effect.Effect<void>
  }>
>('flowdeck/LifecycleHook', { defaultValue: () => ({ afterCommit: () => Effect.void }) })
