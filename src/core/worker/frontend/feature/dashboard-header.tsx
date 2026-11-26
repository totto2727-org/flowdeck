import { ChevronRight } from 'lucide-react'
import type { ReactElement } from 'react'

import { Badge } from './components/generated/badge.tsx'
import { ThemeToggle } from './theme-toggle.tsx'

const controlBadge = (): ReactElement => (
  <Badge variant='outline'>
    <span className='inline-block size-[6px] shrink-0 rounded-full bg-[#418c64]' />
    Control API
  </Badge>
)

const headerControls = (hydrated: boolean): ReactElement => (
  <div className='flex items-center gap-2.5 max-[620px]:gap-2'>
    <ThemeToggle disabled={!hydrated} />
    {controlBadge()}
  </div>
)

export const DashboardHeader = ({ hydrated }: Readonly<{ hydrated: boolean }>): ReactElement => {
  return (
    <header className='flex h-[65px] items-center justify-between border-b border-border bg-card px-9 max-[1100px]:px-6 max-[800px]:h-[48px] max-[620px]:px-4 [&_[data-slot=badge]]:h-auto [&_[data-slot=badge]]:gap-1.5 [&_[data-slot=badge]]:px-2 [&_[data-slot=badge]]:py-1 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]]:font-[450] [&_[data-slot=badge]]:text-[#617369] dark:[&_[data-slot=badge]]:text-muted-foreground'>
      <div className='flex items-center gap-3 text-[11px] text-[#8a958e] dark:text-muted-foreground [&_strong]:font-medium [&_strong]:text-[#425449] dark:[&_strong]:text-foreground max-[620px]:[&>span]:hidden max-[620px]:[&>svg]:hidden'>
        <span>Workspace</span>
        <ChevronRight size={13} />
        <strong>Overview</strong>
      </div>
      {headerControls(hydrated)}
    </header>
  )
}
