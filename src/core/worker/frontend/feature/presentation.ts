import { Array, Match, Number, Option, Order, Schema, String } from 'effect'

import type { NodeId } from '@/core/feature/workflow/domain/identity'
import type { RunStatus, Shapes } from '@/core/feature/workflow/domain/model'

import type { RunEvent } from './view-model'

const jsonIndentationSpaces = 2
const shortIdLength = 8
const minimumGraphSize = { width: 560, height: 220 }
const graphEdgePadding = 40

/** Read-only display serialization uses the same Effect codec as persisted JSON. */
export const renderJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: jsonIndentationSpaces }))

export const eventLabel = (type: string) => String.replaceAll('.', ' ')(type)
export const shortId = (id: string) => String.takeRight(id, shortIdLength)
export const orderedEvents = (events: ReadonlyArray<RunEvent>) =>
  Array.sort(
    events,
    Order.mapInput(Order.Number, (event: RunEvent) => event.sequence),
  )

/** Selection is presentation state. It never changes the persisted node projection. */
export const nodeEvents = (events: ReadonlyArray<RunEvent>, nodeId: NodeId) =>
  orderedEvents(Array.filter(events, (event) => 'nodeId' in event && event.nodeId === nodeId))

export const latestExecution = (events: ReadonlyArray<RunEvent>) =>
  Array.findLast(
    orderedEvents(events),
    (event): event is Extract<RunEvent, { type: 'node.started' | 'node.succeeded' | 'node.failed' }> =>
      event.type === 'node.started' || event.type === 'node.succeeded' || event.type === 'node.failed',
  )

export const runRecoveryAction = (status: RunStatus) =>
  Match.value(status).pipe(
    Match.when('waiting', () => 'resume' as const),
    Match.when('pending', () => 'recover' as const),
    Match.when('running', () => 'recover' as const),
    Match.orElse(() => null),
  )

export const graphSize = (shapes: Shapes) =>
  Array.reduce(shapes.nodes, minimumGraphSize, (size, node) => ({
    width: Number.max(size.width, node.position.x + node.size.width + graphEdgePadding),
    height: Number.max(size.height, node.position.y + node.size.height + graphEdgePadding),
  }))

/** Arrow navigation follows graph definition order, not execution status. */
export const nextNode = (ids: ReadonlyArray<NodeId>, current: NodeId, key: string): NodeId | undefined => {
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
