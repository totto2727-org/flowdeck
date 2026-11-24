import { Array, HashMap, Match, Number, Option, Order, Predicate } from 'effect'

import type { NodeId } from './identity.ts'
import type { GraphDefinition, NodeVisualState, RunEvent, Shapes } from './model.ts'

const LAYOUT_ORIGIN = { x: 48, y: 72 }
const NODE_SIZE = { width: 224, height: 100 }
const NODE_HORIZONTAL_STEP = 280

/** Event order is durable sequence order, independent of wall-clock timestamps. */
export const projectEvents = (
  events: Readonly<RunEvent[]>,
): HashMap.HashMap<string, 'failed' | 'running' | 'waiting' | 'idle' | 'succeeded'> =>
  Array.reduce(
    Array.sort(
      events,
      Order.mapInput(Number.Order, (event: RunEvent) => event.sequence),
    ),
    HashMap.empty<NodeId, NodeVisualState>(),
    (states, event) => {
      if (!('nodeId' in event)) {
        return states
      }
      const visual = Match.value(event.type).pipe(
        Match.when('node.started', () => 'running' as const),
        Match.when('node.succeeded', () => 'succeeded' as const),
        Match.when('node.failed', () => 'failed' as const),
        Match.when('run.waiting', () => 'waiting' as const),
        Match.orElse(() => undefined),
      )
      return Predicate.isUndefined(visual) ? states : HashMap.set(states, event.nodeId, visual)
    },
  )

/** Layout is a pure graph projection. Selection belongs exclusively to the UI. */
export const graphToShapes = (graph: GraphDefinition, events: Readonly<RunEvent[]> = []): Shapes => {
  const states = projectEvents(events)
  const state = (nodeId: NodeId): 'failed' | 'running' | 'waiting' | 'idle' | 'succeeded' =>
    HashMap.get(states, nodeId).pipe(Option.getOrElse(() => 'idle' as const))
  return {
    nodes: Array.map(graph.nodes, (node, index) => ({
      id: node.nodeId,
      nodeId: node.nodeId,
      type: 'node' as const,
      label: node.label,
      kind: node.kind,
      position: { x: LAYOUT_ORIGIN.x + index * NODE_HORIZONTAL_STEP, y: LAYOUT_ORIGIN.y },
      size: NODE_SIZE,
      state: state(node.nodeId),
    })),
    edges: Array.map(graph.edges, (edge) => ({
      id: edge.edgeId,
      type: 'edge' as const,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      traversed:
        Array.some(events, (event) => event.type === 'node.succeeded' && event.nodeId === edge.source) &&
        Array.some(events, (event) => event.type === 'node.started' && event.nodeId === edge.target),
    })),
  }
}
