import { Array, Option, Predicate } from 'effect'
import type { ReactElement } from 'react'

import type { NodeId } from '@/core/feature/workflow/domain/identity'
import type { NodeShape } from '@/core/feature/workflow/domain/model'

import { badgeVariants } from './components/generated/badge.tsx'
import { detailField } from './detail-field.tsx'
import { cn } from './lib/utils.ts'
import { latestExecution, nodeEvents, renderJson } from './presentation.ts'
import type { ExecutionEvent } from './presentation.ts'
import type { RunDetail } from './view-model.ts'

const inspectorClass = 'border-t border-[#e8eee9] px-[23px] py-5 dark:border-border max-[800px]:px-[17px]'
const statusClass = cn(
  badgeVariants({ variant: 'outline' }),
  'h-[21px] gap-1.25 border-[#e0e7e2] bg-[#f4f6f5] text-[10px] font-medium text-[#697c70] capitalize dark:border-[#4c6154] dark:bg-[#27362e] dark:text-[#bdd0c3] data-[state=succeeded]:border-[#d5e9d9] data-[state=succeeded]:bg-[#eef7ef] data-[state=succeeded]:text-[#337246] data-[state=waiting]:border-[#efe3b7] data-[state=waiting]:bg-[#fffae9] data-[state=waiting]:text-[#8a691a] data-[state=running]:border-[#ccdef6] data-[state=running]:bg-[#eef5ff] data-[state=running]:text-[#3f6bb7] data-[state=failed]:border-[#f1cdd1] data-[state=failed]:bg-[#fff1f2] data-[state=failed]:text-[#a9434c] dark:data-[state=succeeded]:border-[#4d805e] dark:data-[state=succeeded]:bg-[#1e3929] dark:data-[state=succeeded]:text-[#a0dfb2] dark:data-[state=waiting]:border-[#78652f] dark:data-[state=waiting]:bg-[#372f1c] dark:data-[state=waiting]:text-[#eed383] dark:data-[state=running]:border-[#5275a2] dark:data-[state=running]:bg-[#1e304a] dark:data-[state=running]:text-[#a9cdfb] dark:data-[state=failed]:border-[#945461] dark:data-[state=failed]:bg-[#3c2228] dark:data-[state=failed]:text-[#ffb4bf]',
)
const caption = (
  <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
    Node inspector
  </p>
)
const empty = (
  <section id='node-inspector' className={inspectorClass}>
    {caption}
    <p className='mt-2.5 text-[11px] text-muted-foreground'>
      Select a node to inspect its executions. Use Tab and Enter, or arrow keys inside the graph.
    </p>
  </section>
)

type InspectorProps = Readonly<{ detail: RunDetail; nodeId: NodeId | null | undefined }>

type EventDetails = Readonly<{
  events: RunDetail['events']
  execution: ExecutionEvent | undefined
  latest: RunDetail['events'][number] | undefined
}>

const inspectEvents = (history: RunDetail['events'], nodeId: NodeId): EventDetails => {
  const events = nodeEvents(history, nodeId)
  return {
    events,
    execution: Option.getOrUndefined(latestExecution(events)),
    latest: Option.getOrUndefined(Array.last(events)),
  }
}

const inspectorHeading = (node: typeof NodeShape.Type): ReactElement => {
  const title = (
    <div>
      {caption}
      <h3 className='text-[15px] font-semibold'>{node.label}</h3>
    </div>
  )
  const badge = (
    <span data-slot='badge' data-variant='outline' className={statusClass} data-state={node.state}>
      {node.state}
    </span>
  )
  return (
    <div className='flex items-center justify-between gap-3.5'>
      {title}
      {badge}
    </div>
  )
}

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function NodeInspector({ detail, nodeId }: InspectorProps): ReactElement {
  const selected = Array.findFirst(detail.shapes.nodes, (item) => item.nodeId === nodeId)
  if (Option.isNone(selected)) {
    return empty
  }

  const node = selected.value
  const { events, execution, latest } = inspectEvents(detail.events, node.nodeId)
  const heading = inspectorHeading(node)
  const properties = (
    <dl className='mt-[17px] grid grid-cols-2 gap-x-5 gap-y-3 [&_dt]:mb-1 [&_dt]:text-[9px] [&_dt]:tracking-[0.7px] [&_dt]:text-[#8a998e] [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-[11px] [&_dd]:wrap-anywhere [&_dd]:text-[#576f5f] dark:[&_dt]:text-muted-foreground dark:[&_dd]:text-foreground [&_code]:font-mono [&_code]:text-[0.9em]'>
      {detailField('Node ID', <code>{node.nodeId}</code>)}
      {detailField('Kind', node.kind)}
      {detailField('Execution', <code>{execution?.executionId ?? 'Not started'}</code>)}
      {detailField('Attempt', execution?.attempt ?? 'Not started')}
    </dl>
  )
  const payload = Predicate.isNotNullish(latest) && (
    <pre
      className='mt-3.5 max-h-[400px] overflow-auto rounded-md border border-[#e7eee9] bg-[#f6f9f7] p-[15px] font-mono text-[10px] whitespace-pre-wrap wrap-anywhere text-[#537360] dark:border-border dark:bg-[#101a14] dark:text-[#b5e4c6]'
      aria-label='Latest node event payload'
    >
      {renderJson(latest.payload)}
    </pre>
  )
  return (
    <section id='node-inspector' className={inspectorClass} aria-live='polite' aria-label='Selected node details'>
      {heading}
      {properties}
      <p className='mt-2.5 text-[11px] text-muted-foreground'>
        {Array.length(events)} persisted node events. Repeated attempts retain distinct execution IDs.
      </p>
      {payload}
    </section>
  )
}
