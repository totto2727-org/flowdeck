import { Array, HashMap, Match, Number, Option, Order } from 'effect'

import type { GraphDefinition, NodeVisualState, RunEvent, Shapes } from './model'

/** Event order is durable sequence order, independent of wall-clock timestamps. */
export const projectEvents = (events: ReadonlyArray<RunEvent>) =>
  Array.reduce(
    Array.sort(
      events,
      Order.mapInput(Number.Order, (event: RunEvent) => event.sequence),
    ),
    HashMap.empty<string, NodeVisualState>(),
    (states, event) => {
      if (event.nodeId === null) return states
      const visual = Match.value(event.type).pipe(
        Match.when('node.started', () => 'running' as const),
        Match.when('node.succeeded', () => 'succeeded' as const),
        Match.when('node.failed', () => 'failed' as const),
        Match.when('run.waiting', () => 'waiting' as const),
        Match.orElse(() => undefined),
      )
      return visual === undefined ? states : HashMap.set(states, event.nodeId, visual)
    },
  )

/** Layout is a pure graph projection. Selection belongs exclusively to the UI. */
export const graphToShapes = (graph: GraphDefinition, events: ReadonlyArray<RunEvent> = []): Shapes => {
  const states = projectEvents(events)
  const state = (nodeId: string) => HashMap.get(states, nodeId).pipe(Option.getOrElse(() => 'idle' as const))
  return {
    nodes: Array.map(graph.nodes, (node, index) => ({
      id: node.nodeId,
      nodeId: node.nodeId,
      type: 'node' as const,
      label: node.label,
      kind: node.kind,
      x: 48 + index * 280,
      y: 72,
      width: 224,
      height: 100,
      state: state(node.nodeId),
    })),
    edges: Array.map(graph.edges, (edge) => ({
      id: edge.edgeId,
      type: 'edge' as const,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      traversed:
        Array.some(events, (event) => event.nodeId === edge.source && event.type === 'node.succeeded') &&
        Array.some(events, (event) => event.nodeId === edge.target && event.type === 'node.started'),
    })),
  }
}
