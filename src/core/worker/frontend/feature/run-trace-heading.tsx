import type { ReactElement } from 'react'

import { Button } from './components/generated/button.tsx'

export type TraceView = 'events' | 'state'
type TraceHeadingProps = Readonly<{
  count: number
  onEvents: () => void
  onState: () => void
  revision: number
  view: TraceView
}>

const title = (
  <div>
    <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
      Source of truth
    </p>
    <h2 className='text-[17px] font-[620] tracking-[-0.35px]' id='trace-heading'>
      State & events
    </h2>
  </div>
)

const controls = ({ count, onEvents, onState, revision, view }: TraceHeadingProps): ReactElement => {
  const eventCount = (
    <span className='ml-1 inline-flex min-w-[20px] items-center justify-center rounded-sm bg-[#edf2ee] px-1.25 align-middle text-[10px] leading-[18px] font-medium text-[#65816c] dark:bg-secondary dark:text-[#b0e6c6]'>
      {count}
    </span>
  )
  const stateRevision = (
    <span className='ml-1 inline-flex min-w-[20px] items-center justify-center rounded-sm bg-[#edf2ee] px-1.25 align-middle text-[10px] leading-[18px] font-medium text-[#65816c] dark:bg-secondary dark:text-[#b0e6c6]'>
      r{revision}
    </span>
  )
  const events = (
    <Button
      type='button'
      size='sm'
      variant={view === 'events' ? 'secondary' : 'ghost'}
      aria-pressed={view === 'events'}
      onClick={onEvents}
    >
      Events {eventCount}
    </Button>
  )
  const state = (
    <Button
      type='button'
      size='sm'
      variant={view === 'state' ? 'secondary' : 'ghost'}
      aria-pressed={view === 'state'}
      onClick={onState}
    >
      State {stateRevision}
    </Button>
  )
  return (
    <div
      className='flex gap-[3px] rounded-[7px] border border-[#e6ece8] p-[3px] dark:border-border [&_button]:text-[10px]'
      aria-label='Trace view'
    >
      {events}
      {state}
    </div>
  )
}

export const RunTraceHeading = (props: TraceHeadingProps): ReactElement => (
  <div className='flex items-center justify-between gap-3.5'>
    {title}
    {controls(props)}
  </div>
)
