import { Predicate } from 'effect'
import { GitBranch } from 'lucide-react'
import type { ReactElement } from 'react'

import { SelectedRun } from './selected-run.tsx'
import type { RunDetail } from './view-model.ts'

const emptyExplorer = (): ReactElement => (
  <section className='flex min-h-[390px] min-w-0 flex-col items-center justify-center overflow-hidden rounded-[10px] border border-border bg-linear-[160deg,#ffffff,#f8fbf9] p-[38px] text-center dark:bg-none dark:bg-card max-[620px]:min-h-[330px] max-[620px]:p-[25px] [&_h2]:mb-2.5 [&_h2]:text-[21px] [&_h2]:font-[620] [&_h2]:tracking-[-0.35px]'>
    <span className='mb-[23px] grid size-[78px] -rotate-6 place-items-center rounded-[20px] border border-[#e0ece2] bg-[#eef5ef] text-[#638e72] dark:border-border dark:bg-secondary dark:text-[#b0e6c6] [&_svg]:rotate-6'>
      <GitBranch size={34} />
    </span>
    <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
      Execution explorer
    </p>
    <h2 className='text-[17px] font-[620] tracking-[-0.35px]'>Your workflow, in focus.</h2>
    <p className='max-w-[350px] text-[12px] leading-[1.8] text-[#7c8b81] dark:text-muted-foreground'>
      Select a run to explore its graph, inspect node executions, and view committed state and events.
    </p>
    <span className='mt-[25px] border-t border-[#e6ede8] pt-[17px] text-[9px] tracking-[1px] text-[#98a79c] uppercase dark:border-border dark:text-muted-foreground'>
      No generated or preview data
    </span>
  </section>
)

type DashboardRunExplorerProps = Readonly<{
  onResume: () => void
  pending: boolean
  selected: RunDetail | null
}>

export const DashboardRunExplorer = ({ onResume, pending, selected }: DashboardRunExplorerProps): ReactElement => (
  <div className='min-w-0'>
    {Predicate.isNotNullish(selected) ? (
      <SelectedRun key={selected.run.runId} detail={selected} pending={pending} onResume={onResume} />
    ) : (
      emptyExplorer()
    )}
  </div>
)
