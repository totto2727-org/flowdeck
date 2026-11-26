import { Array } from 'effect'
import type { ReactElement } from 'react'

const statusColors = [
  { className: 'size-[5px] rounded-full bg-[#b4c2b9] dark:bg-[#a1b6a8]', label: 'Idle' },
  { className: 'size-[5px] rounded-full bg-[#5d8dce] dark:bg-[#a9cdfb]', label: 'Active' },
  { className: 'size-[5px] rounded-full bg-[#5c9c70] dark:bg-[#a0dfb2]', label: 'Succeeded' },
  { className: 'size-[5px] rounded-full bg-[#c4a44a] dark:bg-[#eed383]', label: 'Waiting' },
]
const statuses = Array.map(statusColors, ({ className, label }) => (
  <span key={label}>
    <i className={className} />
    {label}
  </span>
))
const colorKey = (
  <div className='flex gap-[11px] text-[9px] text-[#85948a] dark:text-muted-foreground max-[620px]:flex-wrap [&_span]:flex [&_span]:items-center [&_span]:gap-1'>
    {statuses}
  </div>
)

export const RunTopologyLegend = (): ReactElement => (
  <div className='flex items-center justify-between gap-3 border-t border-[#edf1ee] px-[22px] pt-4 pb-2.5 dark:border-border max-[1100px]:flex-col max-[1100px]:items-start [&>span]:mb-0'>
    <span className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
      Workflow topology
    </span>
    {colorKey}
  </div>
)
