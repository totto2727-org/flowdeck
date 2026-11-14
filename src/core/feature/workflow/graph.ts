import type { Machine } from '@typeonce/effect-machine'
import { Array, HashSet, Option, Schema, String } from 'effect'

import { InvalidSnapshot } from '@/core/feature/workflow/domain/errors'
import { GraphDefinition } from '@/core/feature/workflow/domain/model'

const metadata = Schema.Struct({ title: Schema.String, description: Schema.Literals(['task', 'checkpoint']) })
const decodeMetadata = Schema.decodeUnknownOption(metadata)
const decodeGraph = Schema.decodeUnknownSync(GraphDefinition)

/** Collapse implementation-only states into their annotated business ancestor.
 * Native introspection remains the only source of nodes and outgoing edges. */
export const projectMachineGraph = (options: {
  readonly graphId: string
  readonly nodes: ReadonlyArray<Machine.Machine.StateNode>
  readonly transitions: ReadonlyArray<Machine.Machine.TransitionDefinition>
}): GraphDefinition => {
  const visible = Array.flatMap(options.nodes, (node) =>
    Option.match(decodeMetadata(node.annotations), {
      onNone: () => [],
      onSome: (annotation) => [{ nodeId: node.path, label: annotation.title, kind: annotation.description }],
    }),
  )
  if (visible.length === 0) throw new InvalidSnapshot({ message: 'A workflow graph needs annotated business nodes' })
  const owner = (path: string) =>
    Array.findLast(visible, (node) => path === node.nodeId || String.startsWith(`${node.nodeId}.`)(path))
  // Allocation-only states can sit between visible nodes. Follow their static
  // native edges without evaluating guards, resolvers, or invoked work.
  const destinations = (path: string, visited: HashSet.HashSet<string>): ReadonlyArray<string> => {
    const visibleOwner = owner(path)
    if (Option.isSome(visibleOwner)) return [visibleOwner.value.nodeId]
    if (HashSet.has(visited, path)) return []
    const seen = HashSet.add(visited, path)
    const node = Array.findFirst(options.nodes, (candidate) => candidate.path === path)
    const initial = Option.isSome(node) && node.value.type === 'compound' ? destinations(node.value.initial, seen) : []
    return Array.appendAll(
      initial,
      Array.flatMap(
        Array.filter(options.transitions, (transition) => transition.source === path),
        (transition: Machine.Machine.TransitionDefinition) =>
          Array.flatMap(transition.branches, (branch) =>
            branch.target === undefined ? [] : destinations(branch.target, seen),
          ),
      ),
    )
  }
  const candidates = Array.flatMap(options.transitions, (transition) =>
    Array.flatMap(transition.branches, (branch) => {
      if (branch.target === undefined) return []
      const source = owner(transition.source)
      if (Option.isNone(source)) return []
      const label =
        branch.type === 'branch'
          ? branch.title
          : transition.trigger.type === 'event'
            ? globalThis.String(transition.trigger.event)
            : transition.trigger.type === 'invoke'
              ? transition.trigger.outcome
              : transition.trigger.type
      return Array.flatMap(destinations(branch.target, HashSet.empty()), (target) =>
        target === source.value.nodeId ? [] : [{ source: source.value.nodeId, target, label }],
      )
    }),
  )
  const pairs = Array.dedupeWith(candidates, (a, b) => a.source === b.source && a.target === b.target)
  return decodeGraph({
    graphId: options.graphId,
    schemaVersion: 1,
    nodes: visible,
    edges: Array.map(pairs, (edge) => ({
      edgeId: `${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      label: Array.join(
        Array.dedupe(
          Array.map(
            Array.filter(
              candidates,
              (candidate) => candidate.source === edge.source && candidate.target === edge.target,
            ),
            (candidate) => candidate.label,
          ),
        ),
        ', ',
      ),
    })),
  })
}
