import { Array, Option, Predicate } from 'effect'
import type { ReactElement } from 'react'

import type { Shapes, Size } from '@/core/feature/workflow/domain/model'

import { GraphEdge } from './graph-edge.tsx'

const arrowPath = <path d='M 0 0 L 10 5 L 0 10 z' fill='currentColor' />
const arrow = (
  <defs>
    <marker
      id='edge-arrow'
      viewBox='0 0 10 10'
      refX='9'
      refY='5'
      markerWidth='5'
      markerHeight='5'
      orient='auto-start-reverse'
    >
      {arrowPath}
    </marker>
  </defs>
)

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function GraphEdges({ shapes, size }: Readonly<{ shapes: Shapes; size: Size }>): ReactElement {
  const edges = Array.flatMap(shapes.edges, (edge) => {
    const source = Option.getOrUndefined(Array.findFirst(shapes.nodes, (node) => node.nodeId === edge.source))
    const target = Option.getOrUndefined(Array.findFirst(shapes.nodes, (node) => node.nodeId === edge.target))
    return Predicate.isNullish(source) || Predicate.isNullish(target)
      ? []
      : [<GraphEdge key={edge.id} edge={edge} source={source} target={target} />]
  })
  return (
    <svg
      width={size.width}
      height={size.height}
      aria-hidden='true'
      className='absolute top-0 left-0 text-[#a9bcb0] dark:text-[#80988a]'
    >
      {arrow}
      {edges}
    </svg>
  )
}
