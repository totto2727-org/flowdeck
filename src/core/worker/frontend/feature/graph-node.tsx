import { useCallback, useMemo } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

import type { NodeId } from '@/core/feature/workflow/domain/identity'
import type { NodeShape } from '@/core/feature/workflow/domain/model'

type NodeControls = Readonly<{
  node: typeof NodeShape.Type
  number: number
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>, nodeId: NodeId) => void
  onRegister: (nodeId: NodeId, element: HTMLButtonElement | null) => void
  onSelect: (nodeId: NodeId) => void
  selected: boolean
}>

const stateDot = <span className='inline-block size-[5px] rounded-full bg-current' />

type NodeCallbacks = Pick<NodeControls, 'onNavigate' | 'onRegister' | 'onSelect'> & Readonly<{ nodeId: NodeId }>

type NodeHandlers = Readonly<{
  navigate: (event: KeyboardEvent<HTMLButtonElement>) => void
  register: (element: HTMLButtonElement | null) => void
  select: () => void
}>

const useNodeCallbacks = ({ nodeId, onNavigate, onRegister, onSelect }: NodeCallbacks): NodeHandlers => {
  const register = useCallback(
    (element: HTMLButtonElement | null) => {
      onRegister(nodeId, element)
    },
    [nodeId, onRegister],
  )
  const select = useCallback(() => {
    onSelect(nodeId)
  }, [nodeId, onSelect])
  const navigate = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      onNavigate(event, nodeId)
    },
    [nodeId, onNavigate],
  )
  return { navigate, register, select }
}

export const GraphNode = ({ node, number, onNavigate, onRegister, onSelect, selected }: NodeControls): ReactElement => {
  const { nodeId, position, size } = node
  const { navigate, register, select } = useNodeCallbacks({ nodeId, onNavigate, onRegister, onSelect })
  const geometry = useMemo(
    () => ({ left: position.x, minHeight: size.height, top: position.y, width: size.width }),
    [position, size],
  )
  const numberBadge = (
    <span className='size-[15px] rounded-sm bg-[#f0f4f1] text-center text-[8px] leading-[15px] dark:bg-secondary dark:text-[#b0e6c6]'>
      {number}
    </span>
  )

  return (
    <button
      type='button'
      ref={register}
      className='absolute flex flex-col items-start justify-center gap-[7px] rounded-lg border border-[#dce6df] bg-card px-3.5 py-3 text-left text-[#657b6d] shadow-[0_3px_9px_#1c3c2710] dark:border-border dark:text-foreground data-[state=succeeded]:border-[#99c6a6] data-[state=succeeded]:text-[#4e8d5d] data-[state=running]:border-[#8cb0df] data-[state=running]:text-[#4a7dbb] data-[state=waiting]:border-[#dcc478] data-[state=waiting]:bg-[#fffdf6] data-[state=waiting]:text-[#a18231] data-[state=failed]:border-[#dfa2ab] data-[state=failed]:text-[#ad4b59] dark:data-[state=succeeded]:border-[#78b58d] dark:data-[state=succeeded]:text-[#a0dfb2] dark:data-[state=running]:border-[#86afe3] dark:data-[state=running]:text-[#a9cdfb] dark:data-[state=waiting]:border-[#c7ac5c] dark:data-[state=waiting]:bg-[#302b1e] dark:data-[state=waiting]:text-[#eed383] dark:data-[state=failed]:border-[#d48c9b] dark:data-[state=failed]:text-[#ffb4bf] data-[selected=true]:outline-2 data-[selected=true]:outline-offset-[3px] data-[selected=true]:outline-[#277d59] data-[selected=true]:shadow-[0_0_0_6px_#277d590c] dark:data-[selected=true]:outline-primary dark:data-[selected=true]:shadow-[0_0_0_6px_#74d5a618]'
      data-state={node.state}
      data-selected={selected}
      aria-pressed={selected}
      aria-label={`${node.label}, ${node.kind}, ${node.state}`}
      aria-controls='node-inspector'
      onClick={select}
      onKeyDown={navigate}
      style={geometry}
    >
      <span className='flex items-center gap-1.5 text-[8px] tracking-[0.6px] text-[#91a196] uppercase dark:text-muted-foreground'>
        {numberBadge}
        {node.kind}
      </span>
      <span className='text-[12px] font-semibold text-[#3d5848] dark:text-foreground'>{node.label}</span>
      <span className='flex items-center gap-1.25 text-[9px] capitalize'>
        {stateDot}
        {node.state}
      </span>
    </button>
  )
}
