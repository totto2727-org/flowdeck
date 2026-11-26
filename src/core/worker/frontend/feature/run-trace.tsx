import { Array } from 'effect'
import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'

import type { NodeId } from '@/core/feature/workflow/domain/identity'

import { RunEvents } from './run-events.tsx'
import { RunState } from './run-state.tsx'
import { RunTraceHeading } from './run-trace-heading.tsx'
import type { TraceView } from './run-trace-heading.tsx'
import type { RunDetail } from './view-model.ts'

export const RunTrace = ({ detail, node }: Readonly<{ detail: RunDetail; node: NodeId | undefined }>): ReactElement => {
  const [view, setView] = useState<TraceView>('events')
  const showEvents = useCallback(() => {
    setView('events')
  }, [])
  const showState = useCallback(() => {
    setView('state')
  }, [])
  const content =
    view === 'events' ? <RunEvents events={detail.events} selectedNode={node} /> : <RunState state={detail.state} />
  return (
    <section
      className='mt-5 min-w-0 overflow-hidden rounded-[10px] border border-border bg-card px-[23px] py-[22px] max-[800px]:px-[17px] [&>div:first-child]:mb-[18px] max-[1100px]:[&>div:first-child]:flex-col max-[1100px]:[&>div:first-child]:items-start max-[620px]:[&>div:first-child]:flex-row max-[620px]:[&>div:first-child]:flex-wrap max-[620px]:[&>div:first-child]:items-center'
      aria-labelledby='trace-heading'
    >
      <RunTraceHeading
        count={Array.length(detail.events)}
        onEvents={showEvents}
        onState={showState}
        revision={detail.state.revision}
        view={view}
      />
      {content}
    </section>
  )
}
