import { Array, HashMap, Match, Number, Option, Order } from 'effect'

import type { NodeId } from './identity.ts'
import type { GraphDefinition, NodeVisualState, RunEvent, Shapes } from './model.ts'

const LAYOUT_ORIGIN = { x: 48, y: 72 }
const NODE_SIZE = { height: 100, width: 224 }
const NODE_HORIZONTAL_STEP = 280

// Event order follows the persisted sequence independently of wall-clock timestamps.
export const projectEvents = (events: Readonly<RunEvent[]>): HashMap.HashMap<NodeId, NodeVisualState> =>
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
        Match.option,
      )
      return Option.isNone(visual) ? states : HashMap.set(states, event.nodeId, visual.value)
    },
  )

// The UI owns selection independently of the graph layout.
export const graphToShapes = (graph: GraphDefinition, events: Readonly<RunEvent[]> = []): Shapes => {
  const states = projectEvents(events)
  const state = (nodeId: NodeId): NodeVisualState =>
    HashMap.get(states, nodeId).pipe(Option.getOrElse(() => 'idle' as const))
  return {
    edges: Array.map(graph.edges, (edge) => ({
      id: edge.edgeId,
      label: edge.label,
      source: edge.source,
      target: edge.target,
      traversed:
        Array.some(events, (event) => event.type === 'node.succeeded' && event.nodeId === edge.source) &&
        Array.some(events, (event) => event.type === 'node.started' && event.nodeId === edge.target),
      type: 'edge',
    })),
    nodes: Array.map(graph.nodes, (node, index) => ({
      id: node.nodeId,
      kind: node.kind,
      label: node.label,
      nodeId: node.nodeId,
      position: { x: LAYOUT_ORIGIN.x + index * NODE_HORIZONTAL_STEP, y: LAYOUT_ORIGIN.y },
      size: NODE_SIZE,
      state: state(node.nodeId),
      type: 'node',
    })),
  }
}
