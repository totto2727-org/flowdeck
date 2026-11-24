import type { ReactElement } from 'react'

import { badgeVariants } from './components/generated/badge.tsx'
import { cn } from './lib/utils.ts'

const runStatusStyle = cn(
  badgeVariants({ variant: 'outline' }),
  'h-[21px] gap-1.25 border-[#e0e7e2] bg-[#f4f6f5] text-[10px] font-medium text-[#697c70] capitalize dark:border-[#4c6154] dark:bg-[#27362e] dark:text-[#bdd0c3] data-[state=completed]:border-[#d5e9d9] data-[state=completed]:bg-[#eef7ef] data-[state=completed]:text-[#337246] data-[state=succeeded]:border-[#d5e9d9] data-[state=succeeded]:bg-[#eef7ef] data-[state=succeeded]:text-[#337246] data-[state=waiting]:border-[#efe3b7] data-[state=waiting]:bg-[#fffae9] data-[state=waiting]:text-[#8a691a] data-[state=running]:border-[#ccdef6] data-[state=running]:bg-[#eef5ff] data-[state=running]:text-[#3f6bb7] data-[state=failed]:border-[#f1cdd1] data-[state=failed]:bg-[#fff1f2] data-[state=failed]:text-[#a9434c] dark:data-[state=completed]:border-[#4d805e] dark:data-[state=completed]:bg-[#1e3929] dark:data-[state=completed]:text-[#a0dfb2] dark:data-[state=succeeded]:border-[#4d805e] dark:data-[state=succeeded]:bg-[#1e3929] dark:data-[state=succeeded]:text-[#a0dfb2] dark:data-[state=waiting]:border-[#78652f] dark:data-[state=waiting]:bg-[#372f1c] dark:data-[state=waiting]:text-[#eed383] dark:data-[state=running]:border-[#5275a2] dark:data-[state=running]:bg-[#1e304a] dark:data-[state=running]:text-[#a9cdfb] dark:data-[state=failed]:border-[#945461] dark:data-[state=failed]:bg-[#3c2228] dark:data-[state=failed]:text-[#ffb4bf]',
)
const dot = <span className='inline-block size-[5px] rounded-full bg-current' />

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function RunStatus({ value }: Readonly<{ value: string }>): ReactElement {
  return (
    <span data-slot='badge' data-variant='outline' className={runStatusStyle} data-state={value}>
      {dot}
      {value}
    </span>
  )
}
