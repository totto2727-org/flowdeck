import type { Machine } from '@typeonce/effect-machine'
import { Array, HashSet, Option, Predicate, Result, Schema, String } from 'effect'

import { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { GraphDefinition } from '@/core/feature/workflow/domain/model'

const metadata = Schema.Struct({ description: Schema.Literals(['task', 'checkpoint']), title: Schema.String })
const decodeMetadata = Schema.decodeUnknownOption(metadata)
const decodeGraph = Schema.decodeResult(GraphDefinition)

type NativeGraph = Readonly<{
  graphId: string
  nodes: Readonly<Machine.Machine.StateNode[]>
  transitions: Readonly<Machine.Machine.TransitionDefinition[]>
}>
type VisibleNodes = GraphDefinition['nodes']
type Transition = NativeGraph['transitions'][number]
type Edge = Omit<GraphDefinition['edges'][number], 'edgeId'>

const findOwner = (visible: VisibleNodes, path: string): Option.Option<VisibleNodes[number]> =>
  Array.findLast(visible, (node) => path === node.nodeId || String.startsWith(`${node.nodeId}.`)(path))

// Follow the static edges of allocation-only states without evaluating their native behavior.
const makeDestinationFinder = (
  options: NativeGraph,
  visible: VisibleNodes,
): ((target: string) => Readonly<string[]>) => {
  const visit = (path: string, visited: HashSet.HashSet<string>): Readonly<string[]> => {
    const owner = findOwner(visible, path)
    if (Option.isSome(owner)) {
      return [owner.value.nodeId]
    }
    if (HashSet.has(visited, path)) {
      return []
    }
    const seen = HashSet.add(visited, path)
    const node = Array.findFirst(options.nodes, (candidate) => candidate.path === path)
    const initial = Option.isSome(node) && node.value.type === 'compound' ? visit(node.value.initial, seen) : []
    const successors = Array.filter(options.transitions, (transition) => transition.source === path).flatMap(
      (transition) =>
        Array.flatMap(transition.branches, ({ target }) => (Predicate.isNullish(target) ? [] : visit(target, seen))),
    )
    return Array.appendAll(initial, successors)
  }
  return (target) => visit(target, HashSet.empty())
}

const transitionLabel = (transition: Transition, branch: Transition['branches'][number]): string => {
  if (branch.type === 'branch') {
    return branch.title
  }
  const { trigger } = transition
  if (trigger.type === 'event') {
    return globalThis.String(trigger.event)
  }
  return trigger.type === 'invoke' ? trigger.outcome : trigger.type
}

const edgeCandidates = (options: NativeGraph, visible: VisibleNodes): Edge[] => {
  const destinations = makeDestinationFinder(options, visible)
  return Array.flatMap(options.transitions, (transition) => {
    const owner = findOwner(visible, transition.source)
    if (Option.isNone(owner)) {
      return []
    }
    const { nodeId: source } = owner.value
    return Array.flatMap(transition.branches, (branch) => {
      if (Predicate.isNullish(branch.target)) {
        return []
      }
      const label = transitionLabel(transition, branch)
      return Array.flatMap(destinations(branch.target), (target) =>
        target === source ? [] : [{ label, source, target }],
      )
    })
  })
}

const sameEndpoints = (first: Edge, second: Edge): boolean =>
  first.source === second.source && first.target === second.target

const projectEdges = (candidates: Edge[]): GraphDefinition['edges'] =>
  Array.map(Array.dedupeWith(candidates, sameEndpoints), (edge) => {
    const matches = Array.filter(candidates, (candidate) => sameEndpoints(candidate, edge))
    const labels = Array.dedupe(Array.map(matches, ({ label }) => label))
    return {
      edgeId: `${edge.source}-${edge.target}`,
      label: Array.join(labels, ', '),
      source: edge.source,
      target: edge.target,
    }
  })

/**
 * Collapses implementation-only states into their annotated business ancestor.
 * @param {NativeGraph} options Native introspection for the immutable workflow graph.
 * @returns {GraphDefinition} The business nodes and their outgoing edges, in native order.
 */
export const projectMachineGraph = (options: NativeGraph): GraphDefinition => {
  const nodes = Array.flatMap(options.nodes, (node) =>
    Option.match(decodeMetadata(node.annotations), {
      onNone: () => [],
      onSome: (annotation) => [{ kind: annotation.description, label: annotation.title, nodeId: node.path }],
    }),
  )
  if (Array.isArrayEmpty(nodes)) {
    throw new InvalidSnapshot({ message: 'A workflow graph needs annotated business nodes' })
  }
  const graph = decodeGraph({
    edges: projectEdges(edgeCandidates(options, nodes)),
    graphId: options.graphId,
    nodes,
    schemaVersion: 1,
  })
  return Result.getOrThrow(graph)
}
