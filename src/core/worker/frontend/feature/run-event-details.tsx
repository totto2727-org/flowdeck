import type { ReactElement } from 'react'

import { detailField } from './detail-field.tsx'
import { eventLabel, renderJson } from './presentation.ts'
import type { RunEvent } from './view-model.ts'

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function RunEventDetails({ event }: Readonly<{ event: RunEvent }>): ReactElement {
  const summary = (
    <summary>
      <span className='mr-2.5 font-[550] text-[#526c5b] capitalize dark:text-foreground'>{eventLabel(event.type)}</span>
      <code>{'nodeId' in event ? event.nodeId : 'run'}</code>
      <time dateTime={event.createdAt}>{event.createdAt}</time>
    </summary>
  )
  const fields = (
    <dl className='mt-[17px] grid grid-cols-2 gap-x-5 gap-y-3 [&_dt]:mb-1 [&_dt]:text-[9px] [&_dt]:tracking-[0.7px] [&_dt]:text-[#8a998e] [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-[11px] [&_dd]:wrap-anywhere [&_dd]:text-[#576f5f] dark:[&_dt]:text-muted-foreground dark:[&_dd]:text-foreground'>
      {detailField('Event ID', <code>{event.eventId}</code>)}
      {detailField('Execution ID', <code>{'executionId' in event ? event.executionId : 'Run event'}</code>)}
      {detailField('Attempt', 'attempt' in event ? event.attempt : 'Not applicable')}
    </dl>
  )
  const payload = (
    <pre className='mt-3.5 max-h-[400px] overflow-auto rounded-md border border-[#e7eee9] bg-[#f6f9f7] p-[15px] font-mono text-[10px] whitespace-pre-wrap wrap-anywhere text-[#537360] dark:border-border dark:bg-[#101a14] dark:text-[#b5e4c6]'>
      {renderJson(event.payload)}
    </pre>
  )
  return (
    <details>
      {summary}
      {fields}
      {payload}
    </details>
  )
}
