import { Play } from 'lucide-react'
import type { ReactElement } from 'react'

import { Button } from './components/generated/button.tsx'

type RunRecoveryProps = Readonly<{
  action: 'recover' | 'resume'
  onResume: () => void
  pending: boolean
  version: string
}>

const description = (isResume: boolean, version: string): ReactElement => (
  <div>
    <strong>{isResume ? 'Waiting for an explicit resume' : 'Recover from committed state'}</strong>
    <p>
      {isResume
        ? `The committed state is retained. Resume continues this run with ${version}.`
        : `If execution was interrupted, recover this run with ${version}. Review its committed state and events first.`}
    </p>
  </div>
)

const play = <Play />

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function RunRecovery({ action, onResume, pending, version }: RunRecoveryProps): ReactElement {
  const isResume = action === 'resume'
  return (
    <div className='flex items-center justify-between gap-4 border-y border-[#f3ebcc] bg-[#fffbed] px-5 py-[15px] dark:border-[#78652f] dark:bg-[#372f1c] dark:text-[#eed383] max-[1100px]:flex-col max-[1100px]:items-start [&_strong]:text-[12px] [&_strong]:font-semibold [&_strong]:text-[#7c6221] dark:[&_strong]:text-[#eed383] [&_p]:mt-[3px] [&_p]:max-w-[360px] [&_p]:text-[11px] [&_p]:text-[#9b854c] dark:[&_p]:text-[#eed383] [&_button]:shrink-0 [&_button]:text-[11px]'>
      {description(isResume, version)}
      <Button type='button' disabled={pending} onClick={onResume}>
        {play}
        {isResume ? 'Resume run' : 'Recover run'}
      </Button>
    </div>
  )
}
