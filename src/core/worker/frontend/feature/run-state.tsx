import type { ReactElement } from 'react'

import { Badge } from './components/generated/badge.tsx'
import { renderJson } from './presentation.ts'
import type { RunDetail } from './view-model.ts'

const heading = (revision: number): ReactElement => (
  <div className='flex items-center justify-between gap-3.5'>
    <p className='text-[13px] text-muted-foreground'>Last committed snapshot · revision {revision}</p>
    <Badge variant='outline'>Read only</Badge>
  </div>
)

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function RunState({ state }: Readonly<{ state: RunDetail['state'] }>): ReactElement {
  return (
    <div className='[&>div:first-child]:mb-4 [&>div:first-child]:items-start [&_p]:text-[10px]'>
      {heading(state.revision)}
      <pre
        className='mt-3.5 max-h-[400px] overflow-auto rounded-md border border-[#e7eee9] bg-[#f6f9f7] p-[15px] font-mono text-[10px] whitespace-pre-wrap wrap-anywhere text-[#537360] dark:border-border dark:bg-[#101a14] dark:text-[#b5e4c6]'
        aria-label='Committed run state'
      >
        {renderJson(state.snapshot)}
      </pre>
    </div>
  )
}
