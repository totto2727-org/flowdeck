import { Array } from 'effect'
import type { ReactElement } from 'react'

import { RunEventItem } from './run-event.tsx'
import type { RunEvent } from './view-model.ts'

const noEvents = (
  <p className='py-5 text-[11px] text-[#82988a] dark:text-muted-foreground'>No events for this selection.</p>
)

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function RunEventList({ events }: Readonly<{ events: Readonly<RunEvent[]> }>): ReactElement {
  return Array.isReadonlyArrayEmpty(events) ? (
    noEvents
  ) : (
    <ol className='m-0 list-none p-0 [&>li]:flex [&>li]:items-start [&>li]:gap-3 [&>li]:border-t [&>li]:border-[#edf1ee] [&>li]:py-3 dark:[&>li]:border-border [&_details]:min-w-0 [&_details]:flex-1 [&_summary]:cursor-pointer [&_summary]:text-[10px] [&_summary]:leading-[22px] [&_details[open]_summary]:mb-3 [&_summary_code]:text-[9px] [&_summary_code]:text-[#8a9e90] dark:[&_summary_code]:text-muted-foreground [&_time]:block [&_time]:text-[8px] [&_time]:leading-[1.4] [&_time]:wrap-anywhere [&_time]:text-[#91a497] dark:[&_time]:text-muted-foreground'>
      {Array.map(events, (event) => (
        <RunEventItem key={event.eventId} event={event} />
      ))}
    </ol>
  )
}
