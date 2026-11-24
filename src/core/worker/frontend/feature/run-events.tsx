import { Array, Predicate, String } from 'effect'
import { useCallback, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'

import type { NodeId } from '@/core/feature/workflow/domain/identity'

import { nodeEvents, orderedEvents } from './presentation.ts'
import { RunEventList } from './run-event-list.tsx'
import { RunEventsHeading } from './run-events-heading.tsx'
import type { RunEvent } from './view-model.ts'

type RunEventsProps = Readonly<{
  events: Readonly<RunEvent[]>
  selectedNode: NodeId | null
}>

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function RunEvents({ events, selectedNode }: RunEventsProps): ReactElement {
  const [nodeOnly, setNodeOnly] = useState(false)
  const visible =
    nodeOnly && Predicate.isNotNullish(selectedNode) && String.isNonEmpty(selectedNode)
      ? nodeEvents(events, selectedNode)
      : orderedEvents(events)
  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setNodeOnly(event.target.checked)
  }, [])
  return (
    <section
      className='[&>div:first-child]:mb-4 [&>div:first-child]:items-start max-[1100px]:[&>div:first-child]:flex-wrap [&>div:first-child>p]:text-[10px]'
      aria-label='Persisted events'
    >
      <RunEventsHeading
        checked={nodeOnly}
        count={Array.length(visible)}
        disabled={Predicate.isNullish(selectedNode)}
        onChange={onChange}
      />
      <RunEventList events={visible} />
    </section>
  )
}
