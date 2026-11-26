import { Predicate, String } from 'effect'
import { Activity, Box, Check, GitBranch, RefreshCw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'

import { Button } from './components/generated/button.tsx'
import { Card, CardContent } from './components/generated/card.tsx'

type RefreshProps = Readonly<{ onRefresh: () => void; pending: boolean }>

const overviewHeading = ({ onRefresh, pending }: RefreshProps): ReactElement => {
  const spinClass = pending ? 'animate-spin [animation-duration:1.5s] motion-reduce:animate-none' : ''
  // oxlint-disable-next-line react/forbid-component-props -- Lucide applies the animation class directly to its native SVG.
  const spinner = <RefreshCw className={spinClass} />
  return (
    <div className='mb-[27px] flex items-center justify-between gap-3.5 [&_h1]:mb-1.25 [&_h1]:text-[30px] [&_h1]:leading-[1.35] [&_h1]:font-[650] [&_h1]:tracking-[-1px] max-[620px]:[&_h1]:text-[27px] max-[620px]:[&_p]:text-[11px] max-[620px]:[&>button]:text-[10px]'>
      <div>
        <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
          Workflow orchestration
        </p>
        <h1>Overview</h1>
        <p className='text-[13px] text-muted-foreground'>Start a workflow. Follow every transition.</p>
      </div>
      <Button type='button' variant='outline' disabled={pending} onClick={onRefresh}>
        {spinner}
        Refresh
      </Button>
    </div>
  )
}

type RequestAlertProps = RefreshProps & Readonly<{ error: string }>

const requestAlert = ({ error, onRefresh, pending }: RequestAlertProps): ReactElement => (
  <div
    role='alert'
    className='mb-5 rounded-lg border border-[#edc8cc] bg-[#fff3f3] px-5 py-4 text-[#9b3e45] dark:border-[#945461] dark:bg-[#3c2228] dark:text-[#ffb4bf] [&_p]:mt-1 [&_p]:mb-3 [&_p]:text-[12px]'
  >
    <strong>Request could not be completed</strong>
    <p>{error}</p>
    <Button type='button' variant='outline' size='sm' disabled={pending} onClick={onRefresh}>
      Refresh persisted state
    </Button>
  </div>
)

type MetricCardProps = Readonly<{
  caption: string
  icon: LucideIcon
  label: string
  value: number
}>

const metricCard = ({ caption, icon: Icon, label, value }: MetricCardProps): ReactElement => {
  const labelWithIcon = (
    <span className='flex items-center justify-between text-[11px] text-[#67776d] dark:text-muted-foreground [&_svg]:text-[#8a9e90] dark:[&_svg]:text-muted-foreground'>
      {label}
      <Icon size={16} />
    </span>
  )
  return (
    <Card>
      <CardContent>
        {labelWithIcon}
        <strong className='mt-2 mb-[3px] block text-[29px] leading-[1.4] font-[550] tracking-[-0.75px]'>{value}</strong>
        <span className='text-[10px] text-[#8c9a90] dark:text-muted-foreground max-[800px]:text-[9px] max-[620px]:text-[10px]'>
          {caption}
        </span>
      </CardContent>
    </Card>
  )
}

type OverviewMetricsProps = Readonly<{
  completed: number
  runCount: number
  waiting: number
  workflowCount: number
}>

const overviewMetrics = ({ completed, runCount, waiting, workflowCount }: OverviewMetricsProps): ReactElement => (
  <div className='mb-[25px] grid grid-cols-4 gap-[15px] [&_[data-slot=card]]:shadow-[0_2px_3px_#253a2c03] max-[800px]:gap-2.5 max-[620px]:mb-[18px] max-[620px]:grid-cols-2'>
    {metricCard({
      caption: 'Code-defined, versioned',
      icon: Box,
      label: 'Registered workflows',
      value: workflowCount,
    })}
    {metricCard({ caption: 'Persisted executions', icon: Activity, label: 'Total runs', value: runCount })}
    {metricCard({ caption: 'Explicit resume required', icon: GitBranch, label: 'Waiting', value: waiting })}
    {metricCard({ caption: 'Terminal executions', icon: Check, label: 'Completed', value: completed })}
  </div>
)

type DashboardOverviewProps = RefreshProps &
  OverviewMetricsProps &
  Readonly<{
    error: string | undefined
    message: string
  }>

export const DashboardOverview = ({
  completed,
  error,
  message,
  onRefresh,
  pending,
  runCount,
  waiting,
  workflowCount,
}: DashboardOverviewProps): ReactElement => {
  return (
    <>
      {overviewHeading({ onRefresh, pending })}
      <output aria-live='polite' className='sr-only'>
        {pending ? 'Request in progress.' : message}
      </output>
      {Predicate.isNotNullish(error) && String.isNonEmpty(error) && requestAlert({ error, onRefresh, pending })}
      {overviewMetrics({ completed, runCount, waiting, workflowCount })}
    </>
  )
}
