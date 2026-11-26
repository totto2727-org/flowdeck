import type { ReactElement } from 'react'

import { RunEventDetails } from './run-event-details.tsx'
import type { RunEvent } from './view-model.ts'

export const RunEventItem = ({ event }: Readonly<{ event: RunEvent }>): ReactElement => {
  const number = (
    <span className='w-[22px] shrink-0 rounded-sm bg-[#f1f6f2] text-center text-[9px] leading-[22px] text-[#8ea395] dark:bg-secondary dark:text-[#b0e6c6]'>
      {event.sequence}
    </span>
  )
  return (
    <li>
      {number}
      <RunEventDetails event={event} />
    </li>
  )
}
