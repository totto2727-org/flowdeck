import { ArrowRight } from 'lucide-react'
import { useCallback } from 'react'
import type { ReactElement } from 'react'

import type { RunId } from '@/core/feature/workflow/domain/identity'

import { Badge } from './components/generated/badge.tsx'
import { shortId } from './presentation.ts'
import { RunStatus } from './run-status.tsx'
import type { Run } from './view-model.ts'

const runLabel = (run: Run): ReactElement => (
  <span className='flex items-center justify-between gap-2 [&_code]:text-[12px] [&_code]:font-[550] [&_[data-slot=badge]]:text-[9px]'>
    <code>#{shortId(run.runId)}</code>
    <Badge variant='secondary'>{run.workflowVersion}</Badge>
  </span>
)

const runStatus = (status: Run['status']): ReactElement => (
  <span className='mt-2.5 mb-2 flex items-center justify-between gap-2 max-[620px]:my-1.5 [&>svg]:text-[#8da494] dark:[&>svg]:text-muted-foreground'>
    <RunStatus value={status} />
    <ArrowRight size={14} />
  </span>
)

type RunRowProps = Readonly<{
  onChoose: (id: RunId) => void
  pending: boolean
  run: Run
  selected: boolean
}>

export const RunRow = ({ onChoose, pending, run, selected }: RunRowProps): ReactElement => {
  const choose = useCallback(() => {
    onChoose(run.runId)
  }, [onChoose, run.runId])
  return (
    <li>
      <button
        type='button'
        className='block w-full border-0 border-l-[3px] border-l-transparent bg-card px-[15px] py-4 text-left transition-colors duration-150 hover:bg-[#f7faf8] aria-pressed:border-l-[#32845b] aria-pressed:bg-[#f0f7f2] dark:hover:bg-secondary dark:hover:text-[#b0e6c6] dark:aria-pressed:border-l-primary dark:aria-pressed:bg-secondary dark:aria-pressed:text-[#b0e6c6] max-[620px]:px-[18px] max-[620px]:py-3.5 [&_time]:block [&_time]:text-[9px] [&_time]:wrap-anywhere [&_time]:text-[#7d8c82] dark:[&_time]:text-muted-foreground'
        aria-pressed={selected}
        disabled={pending}
        onClick={choose}
      >
        {runLabel(run)}
        {runStatus(run.status)}
        <time dateTime={run.createdAt}>{run.createdAt}</time>
      </button>
    </li>
  )
}
