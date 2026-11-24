'use client'

import { Array } from 'effect'
import type { ReactElement } from 'react'

import { DashboardHeader } from './dashboard-header.tsx'
import { DashboardNavigation } from './dashboard-navigation.tsx'
import { DashboardOverview } from './dashboard-overview.tsx'
import { DashboardRunExplorer } from './dashboard-run-explorer.tsx'
import { DashboardRunHistory } from './dashboard-run-history.tsx'
import type { DashboardData } from './server.ts'
import { useDashboard } from './use-dashboard.ts'
import type { DashboardController } from './use-dashboard.ts'
import { WorkflowLaunch } from './workflow-launch.tsx'

type RunsPanelProps = Pick<DashboardController, 'chooseRun' | 'pending' | 'resume' | 'selectedRunId'> &
  Readonly<{
    selected: DashboardData['selected']
    visibleRuns: DashboardData['runs']
  }>

const runsPanel = ({
  chooseRun,
  pending,
  resume,
  selected,
  selectedRunId,
  visibleRuns,
}: RunsPanelProps): ReactElement => (
  <div className='grid grid-cols-[260px_minmax(0,1fr)] items-start gap-[22px] min-[1500px]:grid-cols-[290px_minmax(0,1fr)] max-[1100px]:grid-cols-[215px_minmax(0,1fr)] max-[1100px]:gap-4 max-[800px]:grid-cols-[210px_minmax(0,1fr)] max-[800px]:gap-3.5 max-[620px]:grid-cols-[minmax(0,1fr)]'>
    <DashboardRunHistory
      onChoose={chooseRun}
      pending={pending}
      selectedRunId={selectedRunId}
      visibleRuns={visibleRuns}
    />
    <DashboardRunExplorer onResume={resume} pending={pending} selected={selected} />
  </div>
)

const footer = (): ReactElement => (
  <footer className='mt-[35px] flex justify-between gap-3 border-t border-[#e7ede9] pt-[17px] text-[9px] text-[#99a79e] dark:border-border dark:text-muted-foreground max-[620px]:flex-col max-[620px]:gap-1'>
    <span>Flowdeck · Effect-native orchestration</span>
    <span>Graph / State / Events</span>
  </footer>
)

const countRunsWithStatus = (runs: DashboardData['runs'], status: DashboardData['runs'][number]['status']): number =>
  Array.length(Array.filter(runs, (run) => run.status === status))

type LaunchPanelProps = Pick<
  DashboardController,
  'canStart' | 'changeInput' | 'inputs' | 'pending' | 'setVersion' | 'start' | 'version' | 'workflow'
>

const launchPanel = ({
  canStart,
  changeInput,
  inputs,
  pending,
  setVersion,
  start,
  version,
  workflow,
}: LaunchPanelProps): ReactElement => (
  <WorkflowLaunch
    canStart={canStart}
    inputs={inputs}
    onInput={changeInput}
    onStart={start}
    onVersion={setVersion}
    pending={pending}
    version={version}
    workflow={workflow}
  />
)

const dashboardMain = (controller: DashboardController): ReactElement => {
  const { chooseRun, data, error, message, pending, refresh, resume, selectedRunId, workflowId } = controller
  const visibleRuns = Array.filter(data.runs, (run) => run.workflowId === workflowId)
  return (
    <main
      id='main-content'
      className='mx-auto max-w-[1660px] px-9 pt-[35px] pb-5 max-[1100px]:px-6 max-[1100px]:pt-7 max-[620px]:px-4 max-[620px]:pt-6 max-[620px]:pb-4'
      aria-busy={pending}
    >
      <DashboardOverview
        completed={countRunsWithStatus(data.runs, 'completed')}
        error={error}
        message={message}
        onRefresh={refresh}
        pending={pending}
        runCount={Array.length(data.runs)}
        waiting={countRunsWithStatus(data.runs, 'waiting')}
        workflowCount={Array.length(data.workflows)}
      />
      {launchPanel(controller)}
      {runsPanel({ chooseRun, pending, resume, selected: data.selected, selectedRunId, visibleRuns })}
      {footer()}
    </main>
  )
}

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function Dashboard({ initial }: Readonly<{ initial: DashboardData }>): ReactElement {
  const controller = useDashboard(initial)
  const { chooseWorkflow, data, hydrated, pending, workflowId } = controller
  return (
    <div className='grid min-h-dvh grid-cols-[222px_minmax(0,1fr)] max-[1100px]:grid-cols-[185px_minmax(0,1fr)] max-[800px]:grid-cols-1 [&_code]:font-mono [&_code]:text-[0.9em]'>
      <a
        href='#main-content'
        className='fixed -top-[100px] left-2.5 z-20 rounded-md bg-card px-[18px] py-3 focus:top-2.5'
      >
        Skip to dashboard
      </a>
      <DashboardNavigation
        onChoose={chooseWorkflow}
        pending={pending}
        workflowId={workflowId}
        workflows={data.workflows}
      />
      <div className='min-w-0'>
        <DashboardHeader hydrated={hydrated} />
        {dashboardMain(controller)}
      </div>
    </div>
  )
}
