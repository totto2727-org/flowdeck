'use client'

import { Array, Option } from 'effect'
import { useRef, type KeyboardEvent } from 'react'

import type { RunDetail } from '../../../features/workflow/domain/model'
import { Badge } from './components/generated/badge'
import { graphSize, latestExecution, nextNode, nodeEvents, renderJson } from './presentation'

/**
 * Geometry-only inline-style boundary: the persisted graph projection supplies arbitrary
 * canvas width/height and node left/top/width/minHeight at runtime. Tailwind discovers
 * utility classes at build time, so interpolated numeric classes would have no generated
 * rules. Fixed utilities or flow layout cannot keep these nodes aligned with the SVG
 * edge coordinates. The two style attributes below pass only that shared geometry;
 * colors, borders, focus, selection, traversal, spacing, and responsiveness use utilities.
 */
export function RunGraph({
  detail,
  selectedNode,
  onSelect,
}: {
  readonly detail: RunDetail
  readonly selectedNode: string | null
  readonly onSelect: (nodeId: string) => void
}) {
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({})
  const size = graphSize(detail.shapes)
  const ids = Array.map(detail.shapes.nodes, (node) => node.nodeId)
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, nodeId: string) => {
    const next = nextNode(ids, nodeId, event.key)
    if (next === undefined) return
    event.preventDefault()
    onSelect(next)
    buttons.current[next]?.focus()
  }
  return (
    <div
      className='max-w-full overflow-auto bg-[radial-gradient(#dbe4de_0.8px,transparent_0.8px)] bg-size-[16px_16px] dark:bg-[radial-gradient(#3b5042_0.8px,transparent_0.8px)]'
      role='region'
      aria-label='Workflow graph'
      tabIndex={0}
    >
      <div className='relative m-auto' style={{ width: size.width, height: size.height }}>
        <svg
          width={size.width}
          height={size.height}
          aria-hidden='true'
          className='absolute top-0 left-0 text-[#a9bcb0] dark:text-[#80988a]'
        >
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
              <path d='M 0 0 L 10 5 L 0 10 z' fill='currentColor' />
            </marker>
          </defs>
          {Array.map(detail.shapes.edges, (edge) => {
            const source = Option.getOrUndefined(
              Array.findFirst(detail.shapes.nodes, (node) => node.nodeId === edge.source),
            )
            const target = Option.getOrUndefined(
              Array.findFirst(detail.shapes.nodes, (node) => node.nodeId === edge.target),
            )
            if (!source || !target) return null
            const x1 = source.x + source.width
            const y1 = source.y + source.height / 2
            const x2 = target.x
            const y2 = target.y + target.height / 2
            return (
              <g
                key={edge.id}
                data-traversed={edge.traversed}
                className='data-[traversed=true]:text-[#619473] dark:data-[traversed=true]:text-[#8bd7a5] [&_path]:fill-none [&_path]:stroke-[#becdc3] [&_path]:stroke-[1.5] data-[traversed=true]:[&_path]:stroke-[#71a184] data-[traversed=true]:[&_path]:stroke-2 dark:[&_path]:stroke-[#80988a] dark:data-[traversed=true]:[&_path]:stroke-[#8bd7a5] [&_text]:fill-[#7e9586] [&_text]:text-[9px] dark:[&_text]:fill-[#b5ccbd]'
              >
                <path
                  d={`M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}`}
                  markerEnd='url(#edge-arrow)'
                />
                {edge.label && (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 10} textAnchor='middle'>
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {Array.map(detail.shapes.nodes, (node, index) => (
          <button
            type='button'
            key={node.id}
            ref={(element) => {
              buttons.current[node.nodeId] = element
            }}
            className='absolute flex flex-col items-start justify-center gap-[7px] rounded-lg border border-[#dce6df] bg-card px-3.5 py-3 text-left text-[#657b6d] shadow-[0_3px_9px_#1c3c2710] dark:border-border dark:text-foreground data-[state=succeeded]:border-[#99c6a6] data-[state=succeeded]:text-[#4e8d5d] data-[state=running]:border-[#8cb0df] data-[state=running]:text-[#4a7dbb] data-[state=waiting]:border-[#dcc478] data-[state=waiting]:bg-[#fffdf6] data-[state=waiting]:text-[#a18231] data-[state=failed]:border-[#dfa2ab] data-[state=failed]:text-[#ad4b59] dark:data-[state=succeeded]:border-[#78b58d] dark:data-[state=succeeded]:text-[#a0dfb2] dark:data-[state=running]:border-[#86afe3] dark:data-[state=running]:text-[#a9cdfb] dark:data-[state=waiting]:border-[#c7ac5c] dark:data-[state=waiting]:bg-[#302b1e] dark:data-[state=waiting]:text-[#eed383] dark:data-[state=failed]:border-[#d48c9b] dark:data-[state=failed]:text-[#ffb4bf] data-[selected=true]:outline-2 data-[selected=true]:outline-offset-[3px] data-[selected=true]:outline-[#277d59] data-[selected=true]:shadow-[0_0_0_6px_#277d590c] dark:data-[selected=true]:outline-primary dark:data-[selected=true]:shadow-[0_0_0_6px_#74d5a618]'
            data-state={node.state}
            data-selected={selectedNode === node.nodeId}
            aria-pressed={selectedNode === node.nodeId}
            aria-label={`${node.label}, ${node.kind}, ${node.state}`}
            aria-controls='node-inspector'
            onClick={() => onSelect(node.nodeId)}
            onKeyDown={(event) => navigate(event, node.nodeId)}
            style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}
          >
            <span className='flex items-center gap-1.5 text-[8px] tracking-[0.6px] text-[#91a196] uppercase dark:text-muted-foreground'>
              <span className='size-[15px] rounded-sm bg-[#f0f4f1] text-center text-[8px] leading-[15px] dark:bg-secondary dark:text-[#b0e6c6]'>
                {index + 1}
              </span>
              {node.kind}
            </span>
            <span className='text-[12px] font-semibold text-[#3d5848] dark:text-foreground'>{node.label}</span>
            <span className='flex items-center gap-1.25 text-[9px] capitalize'>
              <span className='inline-block size-[5px] rounded-full bg-current' />
              {node.state}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function NodeInspector({ detail, nodeId }: { readonly detail: RunDetail; readonly nodeId: string | null }) {
  const node = Option.getOrUndefined(Array.findFirst(detail.shapes.nodes, (item) => item.nodeId === nodeId))
  if (!node)
    return (
      <section
        id='node-inspector'
        className='border-t border-[#e8eee9] px-[23px] py-5 dark:border-border max-[800px]:px-[17px]'
      >
        <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
          Node inspector
        </p>
        <p className='mt-2.5 text-[11px] text-muted-foreground'>
          Select a node to inspect its executions. Use Tab and Enter, or arrow keys inside the graph.
        </p>
      </section>
    )
  const events = nodeEvents(detail.events, node.nodeId)
  const latest = Option.getOrUndefined(Array.last(events))
  const execution = Option.getOrUndefined(latestExecution(events))
  return (
    <section
      id='node-inspector'
      className='border-t border-[#e8eee9] px-[23px] py-5 dark:border-border max-[800px]:px-[17px]'
      aria-live='polite'
      aria-label='Selected node details'
    >
      <div className='flex items-center justify-between gap-3.5'>
        <div>
          <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
            Node inspector
          </p>
          <h3 className='text-[15px] font-semibold'>{node.label}</h3>
        </div>
        <Badge
          variant='outline'
          data-state={node.state}
          className='h-[21px] gap-1.25 border-[#e0e7e2] bg-[#f4f6f5] text-[10px] font-medium text-[#697c70] capitalize dark:border-[#4c6154] dark:bg-[#27362e] dark:text-[#bdd0c3] data-[state=succeeded]:border-[#d5e9d9] data-[state=succeeded]:bg-[#eef7ef] data-[state=succeeded]:text-[#337246] data-[state=waiting]:border-[#efe3b7] data-[state=waiting]:bg-[#fffae9] data-[state=waiting]:text-[#8a691a] data-[state=running]:border-[#ccdef6] data-[state=running]:bg-[#eef5ff] data-[state=running]:text-[#3f6bb7] data-[state=failed]:border-[#f1cdd1] data-[state=failed]:bg-[#fff1f2] data-[state=failed]:text-[#a9434c] dark:data-[state=succeeded]:border-[#4d805e] dark:data-[state=succeeded]:bg-[#1e3929] dark:data-[state=succeeded]:text-[#a0dfb2] dark:data-[state=waiting]:border-[#78652f] dark:data-[state=waiting]:bg-[#372f1c] dark:data-[state=waiting]:text-[#eed383] dark:data-[state=running]:border-[#5275a2] dark:data-[state=running]:bg-[#1e304a] dark:data-[state=running]:text-[#a9cdfb] dark:data-[state=failed]:border-[#945461] dark:data-[state=failed]:bg-[#3c2228] dark:data-[state=failed]:text-[#ffb4bf]'
        >
          {node.state}
        </Badge>
      </div>
      <dl className='mt-[17px] grid grid-cols-2 gap-x-5 gap-y-3 [&_dt]:mb-1 [&_dt]:text-[9px] [&_dt]:tracking-[0.7px] [&_dt]:text-[#8a998e] [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-[11px] [&_dd]:wrap-anywhere [&_dd]:text-[#576f5f] dark:[&_dt]:text-muted-foreground dark:[&_dd]:text-foreground [&_code]:font-mono [&_code]:text-[0.9em]'>
        <div>
          <dt>Node ID</dt>
          <dd>
            <code>{node.nodeId}</code>
          </dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>{node.kind}</dd>
        </div>
        <div>
          <dt>Execution</dt>
          <dd>
            <code>{execution?.executionId ?? 'Not started'}</code>
          </dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{execution?.attempt ?? 'Not started'}</dd>
        </div>
      </dl>
      <p className='mt-2.5 text-[11px] text-muted-foreground'>
        {Array.length(events)} persisted node events. Repeated attempts retain distinct execution IDs.
      </p>
      {latest && (
        <pre
          className='mt-3.5 max-h-[400px] overflow-auto rounded-md border border-[#e7eee9] bg-[#f6f9f7] p-[15px] font-mono text-[10px] whitespace-pre-wrap wrap-anywhere text-[#537360] dark:border-border dark:bg-[#101a14] dark:text-[#b5e4c6]'
          aria-label='Latest node event payload'
        >
          {renderJson(latest.payload)}
        </pre>
      )}
    </section>
  )
}
