import { Box } from 'lucide-react'
import { useCallback } from 'react'
import type { ReactElement } from 'react'

import type { WorkflowSummary } from './view-model.ts'

export type ChooseWorkflow = (item: WorkflowSummary) => void

type WorkflowChoiceProps = Readonly<{
  item: WorkflowSummary
  onChoose: ChooseWorkflow
  pending: boolean
  selected: boolean
}>

export const WorkflowChoice = ({ item, onChoose, pending, selected }: WorkflowChoiceProps): ReactElement => {
  const choose = useCallback(() => {
    onChoose(item)
  }, [item, onChoose])

  return (
    <button
      type='button'
      className='flex w-full items-center gap-2.5 rounded-md border-0 bg-transparent px-3 py-2.5 text-left text-[12px] font-medium text-[#5c6c62] hover:bg-[#e8efea] hover:text-[#26573c] aria-pressed:bg-[#e8efea] aria-pressed:text-[#26573c] dark:text-muted-foreground dark:hover:bg-secondary dark:hover:text-[#b0e6c6] dark:aria-pressed:bg-secondary dark:aria-pressed:text-[#b0e6c6] max-[800px]:w-auto max-[620px]:p-2 max-[620px]:text-[10px] [&>span]:wrap-anywhere max-[620px]:[&_svg]:hidden'
      aria-pressed={selected}
      disabled={pending}
      onClick={choose}
    >
      <Box size={16} />
      <span>{item.name}</span>
    </button>
  )
}
