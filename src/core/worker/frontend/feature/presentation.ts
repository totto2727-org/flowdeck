import { Array, Function, Match, Number, Option, Order, Schema, String } from 'effect'

import type { NodeId } from '@/core/feature/workflow/domain/identity'
import type { RunStatus, Shapes } from '@/core/feature/workflow/domain/model'

import type { RunEvent } from './view-model.ts'

type ExecutionEvent = Extract<RunEvent, { type: 'node.started' | 'node.succeeded' | 'node.failed' }>
type GraphSize = Readonly<{ height: number; width: number }>

const jsonIndentationSpaces = 2
const shortIdLength = 8
const minimumGraphSize = { height: 220, width: 560 }
const graphEdgePadding = 40
const firstIndex = 0
const adjacentOffset = 1

// Read-only display serialization uses the persisted JSON codec during React render.
// oxlint-disable-next-line node/no-sync -- Encode an in-memory JSON value synchronously during rendering.
export const renderJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: jsonIndentationSpaces }))

export const eventLabel = (type: string): string => String.replaceAll('.', ' ')(type)
export const shortId = (id: string): string => String.takeRight(id, shortIdLength)
export const orderedEvents = (events: Readonly<RunEvent[]>): RunEvent[] =>
  Array.sort(
    events,
    Order.mapInput(Order.Number, (event: RunEvent) => event.sequence),
  )

// Selection is presentation state and leaves the persisted node projection intact.
export const nodeEvents = (events: Readonly<RunEvent[]>, nodeId: NodeId): RunEvent[] =>
  orderedEvents(Array.filter(events, (event) => 'nodeId' in event && event.nodeId === nodeId))

export const latestExecution = (events: Readonly<RunEvent[]>): Option.Option<ExecutionEvent> =>
  Array.findLast(
    orderedEvents(events),
    (event) => event.type === 'node.started' || event.type === 'node.succeeded' || event.type === 'node.failed',
  )

export const runRecoveryAction = (status: RunStatus): 'resume' | 'recover' | undefined =>
  Match.value(status).pipe(
    Match.when('waiting', () => 'resume' as const),
    Match.whenOr('pending', 'running', () => 'recover' as const),
    Match.orElse(Function.constUndefined),
  )

export const graphSize = (shapes: Shapes): GraphSize =>
  Array.reduce(shapes.nodes, minimumGraphSize, (size, node) => ({
    height: Number.max(size.height, node.position.y + node.size.height + graphEdgePadding),
    width: Number.max(size.width, node.position.x + node.size.width + graphEdgePadding),
  }))

// Arrow navigation follows graph definition order.
export const nextNode = (ids: Readonly<NodeId[]>, current: NodeId, key: string): NodeId | undefined => {
  const index = Option.getOrElse(
    Array.findFirstIndex(ids, (id) => id === current),
    () => firstIndex,
  )
  const lastIndex = ids.length - adjacentOffset
  const target = Match.value(key).pipe(
    Match.whenOr('ArrowRight', 'ArrowDown', () => Array.get(ids, Number.min(index + adjacentOffset, lastIndex))),
    Match.whenOr('ArrowLeft', 'ArrowUp', () => Array.get(ids, Number.max(index - adjacentOffset, firstIndex))),
    Match.when('Home', () => Array.head(ids)),
    Match.when('End', () => Array.last(ids)),
    Match.orElse(() => Option.none()),
  )
  return Option.getOrUndefined(target)
}
