'use client'

import { Array, Predicate } from 'effect'
import { useCallback, useMemo, useRef } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

import type { NodeId } from '@/core/feature/workflow/domain/identity'

import { GraphEdges } from './graph-edges.tsx'
import { GraphNode } from './graph-node.tsx'
import { graphSize, nextNode } from './presentation.ts'
import type { RunDetail } from './view-model.ts'

export { NodeInspector } from './node-inspector.tsx'

type RunGraphProps = Readonly<{
  detail: RunDetail
  onSelect: (nodeId: NodeId) => void
  selectedNode: NodeId | null | undefined
}>

const firstNodeNumber = 1

type GraphNavigation = Readonly<{
  navigate: (event: KeyboardEvent<HTMLButtonElement>, nodeId: NodeId) => void
  register: (nodeId: NodeId, element: HTMLButtonElement | null) => void
}>

const useGraphNavigation = (
  nodes: RunDetail['shapes']['nodes'],
  onSelect: RunGraphProps['onSelect'],
): GraphNavigation => {
  const buttons = useRef(new Map<NodeId, HTMLButtonElement>())
  const ids = useMemo(() => Array.map(nodes, (node) => node.nodeId), [nodes])
  const register = useCallback((nodeId: NodeId, element: HTMLButtonElement | null) => {
    if (Predicate.isNullish(element)) {
      buttons.current.delete(nodeId)
    } else {
      buttons.current.set(nodeId, element)
    }
  }, [])
  const navigate = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, nodeId: NodeId) => {
      const next = nextNode(ids, nodeId, event.key)
      if (Predicate.isNullish(next)) {
        return
      }
      event.preventDefault()
      onSelect(next)
      buttons.current.get(next)?.focus()
    },
    [ids, onSelect],
  )
  return { navigate, register }
}

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function RunGraph({ detail, onSelect, selectedNode }: RunGraphProps): ReactElement {
  const { shapes } = detail
  const { nodes } = shapes
  const size = useMemo(() => graphSize(shapes), [shapes])
  const { navigate, register } = useGraphNavigation(nodes, onSelect)
  const controls = Array.map(nodes, (node, index) => (
    <GraphNode
      key={node.id}
      node={node}
      number={index + firstNodeNumber}
      onNavigate={navigate}
      onRegister={register}
      onSelect={onSelect}
      selected={selectedNode === node.nodeId}
    />
  ))

  // Width and height come from the same graph geometry as the SVG edge coordinates.
  const canvas = (
    <div className='relative m-auto' style={size}>
      <GraphEdges shapes={shapes} size={size} />
      {controls}
    </div>
  )

  return (
    <section
      className='max-w-full overflow-auto bg-[radial-gradient(#dbe4de_0.8px,transparent_0.8px)] bg-size-[16px_16px] dark:bg-[radial-gradient(#3b5042_0.8px,transparent_0.8px)]'
      aria-label='Workflow graph'
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The scroll region stays reachable by keyboard.
      tabIndex={0}
    >
      {canvas}
    </section>
  )
}
