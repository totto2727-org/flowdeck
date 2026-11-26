import type { ReactElement } from 'react'

import { Badge } from './components/generated/badge.tsx'
import { shortId } from './presentation.ts'
import { RunStatus } from './run-status.tsx'
import type { RunDetail } from './view-model.ts'

const heading = (runId: string): ReactElement => {
  const identifier = <span className='font-mono text-[0.9em]'>#{shortId(runId)}</span>
  const title = (
    <h2 className='text-[17px] font-[620] tracking-[-0.35px]' id='selected-run-heading'>
      Execution {identifier}
    </h2>
  )
  return (
    <div>
      <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
        Selected run
      </p>
      {title}
    </div>
  )
}

const badges = (run: RunDetail['run']): ReactElement => (
  <div className='flex items-center gap-2'>
    <Badge variant='secondary'>{run.workflowVersion}</Badge>
    <RunStatus value={run.status} />
  </div>
)

export const SelectedRunHeader = ({ run }: Readonly<{ run: RunDetail['run'] }>): ReactElement => (
  <div className='flex items-center justify-between gap-3.5 px-[23px] pt-[22px] pb-2.5 max-[1100px]:flex-wrap max-[1100px]:items-start max-[800px]:px-[17px]'>
    {heading(run.runId)}
    {badges(run)}
  </div>
)
