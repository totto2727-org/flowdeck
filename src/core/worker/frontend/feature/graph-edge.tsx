import { String } from 'effect'
import type { ReactElement } from 'react'

import type { EdgeShape, NodeShape } from '@/core/feature/workflow/domain/model'

const midpointDivisor = 2
const curveOffset = 28
const labelOffset = 10

type Edge = typeof EdgeShape.Type
type Node = typeof NodeShape.Type
type GraphEdgeProps = Readonly<{ edge: Edge; source: Node; target: Node }>

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function GraphEdge({ edge, source, target }: GraphEdgeProps): ReactElement {
  const x1 = source.position.x + source.size.width
  const y1 = source.position.y + source.size.height / midpointDivisor
  const x2 = target.position.x
  const y2 = target.position.y + target.size.height / midpointDivisor
  const curve = `M ${x1} ${y1} C ${x1 + curveOffset} ${y1}, ${x2 - curveOffset} ${y2}, ${x2} ${y2}`
  return (
    <g
      data-traversed={edge.traversed}
      className='data-[traversed=true]:text-[#619473] dark:data-[traversed=true]:text-[#8bd7a5] [&_path]:fill-none [&_path]:stroke-[#becdc3] [&_path]:stroke-[1.5] data-[traversed=true]:[&_path]:stroke-[#71a184] data-[traversed=true]:[&_path]:stroke-2 dark:[&_path]:stroke-[#80988a] dark:data-[traversed=true]:[&_path]:stroke-[#8bd7a5] [&_text]:fill-[#7e9586] [&_text]:text-[9px] dark:[&_text]:fill-[#b5ccbd]'
    >
      <path d={curve} markerEnd='url(#edge-arrow)' />
      {String.isNonEmpty(edge.label) && (
        <text x={(x1 + x2) / midpointDivisor} y={(y1 + y2) / midpointDivisor - labelOffset} textAnchor='middle'>
          {edge.label}
        </text>
      )}
    </g>
  )
}
