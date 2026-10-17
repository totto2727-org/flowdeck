'use client'

import { Array, Option } from 'effect'
import { useRef, type KeyboardEvent } from 'react'

import type { RunDetail } from '../domain/model'
import { Badge } from './components/generated/badge'
import { graphSize, latestExecution, nextNode, nodeEvents, renderJson } from './presentation'

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
    <div className='graph-scroll' role='region' aria-label='Workflow graph' tabIndex={0}>
      <div className='graph-canvas' style={{ width: size.width, height: size.height }}>
        <svg width={size.width} height={size.height} aria-hidden='true' className='graph-edges'>
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
              <g key={edge.id} data-traversed={edge.traversed} className='graph-edge'>
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
            className='graph-node'
            data-state={node.state}
            data-selected={selectedNode === node.nodeId}
            aria-pressed={selectedNode === node.nodeId}
            aria-label={`${node.label}, ${node.kind}, ${node.state}`}
            aria-controls='node-inspector'
            onClick={() => onSelect(node.nodeId)}
            onKeyDown={(event) => navigate(event, node.nodeId)}
            style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}
          >
            <span className='node-meta'>
              <span className='node-number'>{index + 1}</span>
              {node.kind}
            </span>
            <span className='node-label'>{node.label}</span>
            <span className='node-status'>
              <span className='status-dot' />
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
      <section id='node-inspector' className='node-inspector'>
        <p className='eyebrow'>Node inspector</p>
        <p className='muted'>
          Select a node to inspect its executions. Use Tab and Enter, or arrow keys inside the graph.
        </p>
      </section>
    )
  const events = nodeEvents(detail.events, node.nodeId)
  const latest = Option.getOrUndefined(Array.last(events))
  const execution = Option.getOrUndefined(latestExecution(events))
  return (
    <section id='node-inspector' className='node-inspector' aria-live='polite' aria-label='Selected node details'>
      <div className='section-heading'>
        <div>
          <p className='eyebrow'>Node inspector</p>
          <h3>{node.label}</h3>
        </div>
        <Badge variant='outline' className={`status-badge status-${node.state}`}>
          {node.state}
        </Badge>
      </div>
      <dl className='detail-grid'>
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
      <p className='muted'>
        {Array.length(events)} persisted node events. Repeated attempts retain distinct execution IDs.
      </p>
      {latest && (
        <pre className='json-view' aria-label='Latest node event payload'>
          {renderJson(latest.payload)}
        </pre>
      )}
    </section>
  )
}
