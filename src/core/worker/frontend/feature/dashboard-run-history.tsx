import { Array } from 'effect'
import { Activity } from 'lucide-react'
import type { ReactElement } from 'react'

import type { RunId } from '@/core/feature/workflow/domain/identity'

import { RunRow } from './dashboard-run-row.tsx'
import type { Run } from './view-model.ts'

const historyLabel = (count: number): ReactElement => (
  <div>
    <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
      Execution history
    </p>
    <h2 className='text-[17px] font-[620] tracking-[-0.35px]' id='runs-heading'>
      Runs{' '}
      <span className='ml-1 inline-flex min-w-[20px] items-center justify-center rounded-sm bg-[#edf2ee] px-1.25 align-middle text-[10px] leading-[18px] font-medium text-[#65816c] dark:bg-secondary dark:text-[#b0e6c6]'>
        {count}
      </span>
    </h2>
  </div>
)

const historyHeading = (count: number): ReactElement => (
  <div className='flex items-center justify-between gap-3.5'>
    {historyLabel(count)}
    <span className='text-[11px] text-muted-foreground'>Newest first</span>
  </div>
)

const emptyHistory = (): ReactElement => (
  <div className='px-5 py-[45px] text-center text-[#8c9d91] dark:text-muted-foreground [&_svg]:mx-auto [&_svg]:mb-[15px] [&_h3]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-[#4e6656] dark:[&_h3]:text-foreground [&_p]:text-[12px]'>
    <Activity size={28} />
    <h3>No runs yet</h3>
    <p>Choose a version and start the first run for this workflow.</p>
  </div>
)

type DashboardRunHistoryProps = Readonly<{
  onChoose: (id: RunId) => void
  pending: boolean
  selectedRunId: RunId | undefined
  visibleRuns: Readonly<Run[]>
}>

const runList = ({ onChoose, pending, selectedRunId, visibleRuns }: DashboardRunHistoryProps): ReactElement => (
  <ul
    className='m-0 max-h-[650px] list-none overflow-y-auto p-0 max-[620px]:max-h-[270px] [&>li+li]:border-t [&>li+li]:border-[#edf0ee] dark:[&>li+li]:border-border'
    aria-label='Persisted runs'
  >
    {Array.map(visibleRuns, (run) => (
      <RunRow key={run.runId} onChoose={onChoose} pending={pending} run={run} selected={selectedRunId === run.runId} />
    ))}
  </ul>
)

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function DashboardRunHistory({
  onChoose,
  pending,
  selectedRunId,
  visibleRuns,
}: DashboardRunHistoryProps): ReactElement {
  return (
    <section
      className='min-w-0 overflow-hidden rounded-[10px] border border-border bg-card [&>div:first-child]:border-b [&>div:first-child]:border-[#edf0ee] [&>div:first-child]:px-[18px] [&>div:first-child]:pt-5 [&>div:first-child]:pb-4 dark:[&>div:first-child]:border-border'
      aria-labelledby='runs-heading'
    >
      {historyHeading(Array.length(visibleRuns))}
      {Array.isReadonlyArrayNonEmpty(visibleRuns)
        ? runList({ onChoose, pending, selectedRunId, visibleRuns })
        : emptyHistory()}
    </section>
  )
}
