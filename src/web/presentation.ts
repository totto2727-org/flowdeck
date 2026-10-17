import { Array, Match, Number, Option, Order, Schema, String } from 'effect'

import type { RunEvent, RunStatus, Shapes } from '../domain/model'

/** Read-only display serialization uses the same Effect codec as persisted JSON. */
export const renderJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const eventLabel = (type: string) => String.replaceAll('.', ' ')(type)
export const shortId = (id: string) => String.takeRight(id, 8)
export const orderedEvents = (events: ReadonlyArray<RunEvent>) =>
  Array.sort(
    events,
    Order.mapInput(Order.Number, (event: RunEvent) => event.sequence),
  )

/** Selection is presentation state. It never changes the persisted node projection. */
export const nodeEvents = (events: ReadonlyArray<RunEvent>, nodeId: string) =>
  orderedEvents(Array.filter(events, (event) => event.nodeId === nodeId))

export const latestExecution = (events: ReadonlyArray<RunEvent>) =>
  Array.findLast(
    orderedEvents(events),
    (event) => String.startsWith('node.')(event.type) && event.executionId !== null && event.attempt !== null,
  )

export const runRecoveryAction = (status: RunStatus) =>
  Match.value(status).pipe(
    Match.when('waiting', () => 'resume' as const),
    Match.when('pending', () => 'recover' as const),
    Match.when('running', () => 'recover' as const),
    Match.orElse(() => null),
  )

export const graphSize = (shapes: Shapes) =>
  Array.reduce(shapes.nodes, { width: 560, height: 220 }, (size, node) => ({
    width: Number.max(size.width, node.x + node.width + 40),
    height: Number.max(size.height, node.y + node.height + 40),
  }))

/** Arrow navigation follows graph definition order, not execution status. */
export const nextNode = (ids: ReadonlyArray<string>, current: string, key: string): string | undefined => {
  const index = Option.getOrElse(
    Array.findFirstIndex(ids, (id) => id === current),
    () => 0,
  )
  const target = Match.value(key).pipe(
    Match.when('ArrowRight', () => Number.min(index + 1, Array.length(ids) - 1)),
    Match.when('ArrowDown', () => Number.min(index + 1, Array.length(ids) - 1)),
    Match.when('ArrowLeft', () => Number.max(index - 1, 0)),
    Match.when('ArrowUp', () => Number.max(index - 1, 0)),
    Match.when('Home', () => 0),
    Match.when('End', () => Array.length(ids) - 1),
    Match.orElse(() => -1),
  )
  return Option.getOrUndefined(Array.get(ids, target))
}
