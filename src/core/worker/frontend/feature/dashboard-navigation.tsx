import { Array } from 'effect'
import { Activity, ChevronRight, Layers } from 'lucide-react'
import type { ReactElement } from 'react'

import { WorkflowChoice } from './dashboard-workflow-choice.tsx'
import type { ChooseWorkflow } from './dashboard-workflow-choice.tsx'
import type { WorkflowSummary } from './view-model.ts'

const workspaceBrand = (): ReactElement => (
  <a
    className='flex items-center gap-[9px] px-1.5 text-[22px] font-bold tracking-[-0.8px] max-[1100px]:gap-1.5 max-[1100px]:text-[19px] max-[800px]:shrink-0 max-[800px]:text-[20px]'
    href='/'
    aria-label='Flowdeck home'
  >
    <span className='inline-flex size-[31px] items-center justify-center rounded-lg bg-[#1e4437] text-[#c8f2d5]'>
      <Layers size={21} />
    </span>
    flowdeck
  </a>
)

const workspaceDetails = (): ReactElement => (
  <div className='flex items-center gap-2.5 px-[7px] pt-[26px] pb-[30px] max-[800px]:hidden [&_strong]:block [&_strong]:text-[12px] [&_strong]:font-semibold [&_div>span]:block [&_div>span]:text-[10px] [&_div>span]:text-[#76877d] dark:[&_div>span]:text-muted-foreground'>
    <span className='grid size-[33px] place-items-center rounded-lg border border-border bg-card font-semibold text-[#51705e] dark:text-foreground'>
      F
    </span>
    <div>
      <strong>Control plane</strong>
      <span>Workflow workspace</span>
    </div>
  </div>
)

const controlBinding = (): ReactElement => (
  <div className='mt-auto flex items-center gap-[9px] px-2 pt-6 max-[800px]:hidden [&_strong]:block [&_strong]:text-[12px] [&_strong]:font-semibold [&_div>span]:block [&_div>span]:text-[10px] [&_div>span]:text-[#76877d] dark:[&_div>span]:text-muted-foreground'>
    <span className='inline-block size-[6px] shrink-0 rounded-full bg-[#418c64]' />
    <div>
      <strong>Workflow control</strong>
      <span>Static service binding</span>
    </div>
  </div>
)

type DashboardNavigationProps = Readonly<{
  onChoose: ChooseWorkflow
  pending: boolean
  workflowId: string
  workflows: Readonly<WorkflowSummary[]>
}>

export const DashboardNavigation = ({
  onChoose,
  pending,
  workflowId,
  workflows,
}: DashboardNavigationProps): ReactElement => (
  <aside
    className='flex flex-col border-r border-border bg-[#f0f5f2] px-4 pt-[25px] pb-5 dark:bg-[#141e18] max-[800px]:flex-row max-[800px]:items-center max-[800px]:gap-5 max-[800px]:border-r-0 max-[800px]:border-b max-[800px]:px-5 max-[800px]:py-[15px] max-[620px]:gap-2.5 max-[620px]:px-4 max-[620px]:py-3.5'
    aria-label='Workflow navigation'
  >
    {workspaceBrand()}
    {workspaceDetails()}
    <div className='flex items-center justify-between px-2.5 pb-2.5 text-[9px] font-semibold tracking-[1px] text-[#7b8b81] uppercase dark:text-muted-foreground max-[800px]:hidden'>
      Workspace
    </div>
    <a
      className='flex w-full items-center gap-2.5 rounded-md border-0 bg-[#e0ebe3] px-3 py-2.5 text-left text-[12px] font-medium text-[#23553b] dark:bg-secondary dark:text-[#b0e6c6] max-[800px]:hidden [&>svg:last-child]:ml-auto'
      href='#main-content'
    >
      <Activity size={17} />
      Overview
      <ChevronRight size={14} />
    </a>
    <div className='mt-[30px] flex items-center justify-between px-2.5 pb-2.5 text-[9px] font-semibold tracking-[1px] text-[#7b8b81] uppercase dark:text-muted-foreground max-[800px]:hidden'>
      Workflows <span>{Array.length(workflows)}</span>
    </div>
    <nav className='max-[800px]:ml-auto max-[800px]:flex max-[800px]:flex-wrap' aria-label='Registered workflows'>
      {Array.map(workflows, (item) => (
        <WorkflowChoice
          key={item.workflowId}
          item={item}
          onChoose={onChoose}
          pending={pending}
          selected={workflowId === item.workflowId}
        />
      ))}
    </nav>
    {controlBinding()}
  </aside>
)
