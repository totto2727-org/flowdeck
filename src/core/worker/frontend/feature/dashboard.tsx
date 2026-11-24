'use client'

import { Array, Effect, Option, Predicate, Record } from 'effect'
import { Activity, ArrowRight, Box, Check, ChevronRight, GitBranch, Layers, Play, RefreshCw } from 'lucide-react'
import { Fragment, useState, useSyncExternalStore, useTransition } from 'react'

import type { RunId } from '@/core/feature/workflow/domain/identity'

import { Badge } from './components/generated/badge.tsx'
import { Button } from './components/generated/button.tsx'
import { Card, CardContent } from './components/generated/card.tsx'
import { shortId } from './presentation.ts'
import { RunStatus } from './run-status.tsx'
import { SelectedRun } from './selected-run.tsx'
import { loadDashboard, resumeRun, selectRun, startRun } from './server.ts'
import type { DashboardData, Result } from './server.ts'
import { ThemeToggle } from './theme-toggle.tsx'

// SSR controls stay inert until React has attached their event handlers.
const subscribeHydration = () => () => undefined
const hydratedSnapshot = (): boolean => true
const serverSnapshot = (): boolean => false

export function Dashboard({ initial }: Readonly<{ initial: DashboardData }>) {
  const hydrated = useSyncExternalStore(subscribeHydration, hydratedSnapshot, serverSnapshot)
  const [data, setData] = useState(initial)
  const firstWorkflow = Option.getOrUndefined(Array.head(initial.workflows))
  const [workflowId, setWorkflowId] = useState(firstWorkflow?.workflowId ?? '')
  const [version, setVersion] = useState(Option.getOrUndefined(Array.head(firstWorkflow?.versions ?? [])) ?? '')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [inFlight, transition] = useTransition()
  const pending = !hydrated || inFlight
  const workflow = Option.getOrUndefined(Array.findFirst(data.workflows, (item) => item.workflowId === workflowId))
  const visibleRuns = Array.filter(data.runs, (run) => run.workflowId === workflowId)
  const waiting = Array.length(Array.filter(data.runs, (run) => run.status === 'waiting'))
  const completed = Array.length(Array.filter(data.runs, (run) => run.status === 'completed'))
  const invoke = <A,>(call: () => Promise<Result<A>>, success: (value: A) => void): void => {
    setError(null)
    transition(async () => {
      await Effect.runPromise(
        Effect.tryPromise({
          catch: () => 'The connection was interrupted. Refresh to check the current persisted state before retrying.',
          try: call,
        }).pipe(
          Effect.match({
            onFailure: setError,
            onSuccess: (result) => {
              if (result.ok) {
                success(result.value)
              } else {
                setError(result.message)
              }
            },
          }),
        ),
      )
    })
  }
  const refresh = (): void => {
    invoke(
      () => loadDashboard(data.selected?.run.runId ?? null),
      (value) => {
        setData(value)
        setMessage('Dashboard refreshed from the control plane.')
      },
    )
  }
  const chooseRun = (runId: RunId): void => {
    invoke(
      () => selectRun(runId),
      (detail) => {
        setData((current) => ({ ...current, selected: detail }))
        setMessage(`Selected run ${shortId(runId)}.`)
      },
    )
  }
  const start = (): void => {
    if (!workflow || !Array.contains(workflow.versions, version)) {
      return
    }
    const input = { ...inputs, workflowId, version }
    invoke(
      () => startRun(input),
      ({ detail, runs }) => {
        setData((current) => ({ ...current, runs, selected: detail }))
        setMessage(`Started ${detail.run.workflowVersion} run ${shortId(detail.run.runId)}.`)
      },
    )
  }
  const resume = (): void => {
    const runId = data.selected?.run.runId
    if (!runId) {
      return
    }
    invoke(
      () => resumeRun(runId),
      ({ detail, runs }) => {
        setData((current) => ({ ...current, runs, selected: detail }))
        setMessage(`Run ${shortId(detail.run.runId)} is ${detail.run.status}.`)
      },
    )
  }
  return (
    <div className='grid min-h-dvh grid-cols-[222px_minmax(0,1fr)] max-[1100px]:grid-cols-[185px_minmax(0,1fr)] max-[800px]:grid-cols-1 [&_code]:font-mono [&_code]:text-[0.9em]'>
      <a
        href='#main-content'
        className='fixed -top-[100px] left-2.5 z-20 rounded-md bg-card px-[18px] py-3 focus:top-2.5'
      >
        Skip to dashboard
      </a>
      <aside
        className='flex flex-col border-r border-border bg-[#f0f5f2] px-4 pt-[25px] pb-5 dark:bg-[#141e18] max-[800px]:flex-row max-[800px]:items-center max-[800px]:gap-5 max-[800px]:border-r-0 max-[800px]:border-b max-[800px]:px-5 max-[800px]:py-[15px] max-[620px]:gap-2.5 max-[620px]:px-4 max-[620px]:py-3.5'
        aria-label='Workflow navigation'
      >
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
        <div className='flex items-center gap-2.5 px-[7px] pt-[26px] pb-[30px] max-[800px]:hidden [&_strong]:block [&_strong]:text-[12px] [&_strong]:font-semibold [&_div>span]:block [&_div>span]:text-[10px] [&_div>span]:text-[#76877d] dark:[&_div>span]:text-muted-foreground'>
          <span className='grid size-[33px] place-items-center rounded-lg border border-border bg-card font-semibold text-[#51705e] dark:text-foreground'>
            F
          </span>
          <div>
            <strong>Control plane</strong>
            <span>Workflow workspace</span>
          </div>
        </div>
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
          Workflows <span>{Array.length(data.workflows)}</span>
        </div>
        <nav className='max-[800px]:ml-auto max-[800px]:flex max-[800px]:flex-wrap' aria-label='Registered workflows'>
          {Array.map(data.workflows, (item) => (
            <button
              key={item.workflowId}
              type='button'
              className='flex w-full items-center gap-2.5 rounded-md border-0 bg-transparent px-3 py-2.5 text-left text-[12px] font-medium text-[#5c6c62] hover:bg-[#e8efea] hover:text-[#26573c] aria-pressed:bg-[#e8efea] aria-pressed:text-[#26573c] dark:text-muted-foreground dark:hover:bg-secondary dark:hover:text-[#b0e6c6] dark:aria-pressed:bg-secondary dark:aria-pressed:text-[#b0e6c6] max-[800px]:w-auto max-[620px]:p-2 max-[620px]:text-[10px] [&>span]:wrap-anywhere max-[620px]:[&_svg]:hidden'
              aria-pressed={workflowId === item.workflowId}
              disabled={pending}
              onClick={() => {
                setWorkflowId(item.workflowId)
                setVersion(Option.getOrUndefined(Array.head(item.versions)) ?? '')
                setInputs({})
                setData((current) => ({ ...current, selected: null }))
              }}
            >
              <Box size={16} />
              <span>{item.name}</span>
            </button>
          ))}
        </nav>
        <div className='mt-auto flex items-center gap-[9px] px-2 pt-6 max-[800px]:hidden [&_strong]:block [&_strong]:text-[12px] [&_strong]:font-semibold [&_div>span]:block [&_div>span]:text-[10px] [&_div>span]:text-[#76877d] dark:[&_div>span]:text-muted-foreground'>
          <span className='inline-block size-[6px] shrink-0 rounded-full bg-[#418c64]' />
          <div>
            <strong>Workflow control</strong>
            <span>Static service binding</span>
          </div>
        </div>
      </aside>
      <div className='min-w-0'>
        <header className='flex h-[65px] items-center justify-between border-b border-border bg-card px-9 max-[1100px]:px-6 max-[800px]:h-[48px] max-[620px]:px-4 [&_[data-slot=badge]]:h-auto [&_[data-slot=badge]]:gap-1.5 [&_[data-slot=badge]]:px-2 [&_[data-slot=badge]]:py-1 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]]:font-[450] [&_[data-slot=badge]]:text-[#617369] dark:[&_[data-slot=badge]]:text-muted-foreground'>
          <div className='flex items-center gap-3 text-[11px] text-[#8a958e] dark:text-muted-foreground [&_strong]:font-medium [&_strong]:text-[#425449] dark:[&_strong]:text-foreground max-[620px]:[&>span]:hidden max-[620px]:[&>svg]:hidden'>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>Overview</strong>
          </div>
          <div className='flex items-center gap-2.5 max-[620px]:gap-2'>
            <ThemeToggle disabled={!hydrated} />
            <Badge variant='outline'>
              <span className='inline-block size-[6px] shrink-0 rounded-full bg-[#418c64]' />
              Control API
            </Badge>
          </div>
        </header>
        <main
          id='main-content'
          className='mx-auto max-w-[1660px] px-9 pt-[35px] pb-5 max-[1100px]:px-6 max-[1100px]:pt-7 max-[620px]:px-4 max-[620px]:pt-6 max-[620px]:pb-4'
          aria-busy={pending}
        >
          <div className='mb-[27px] flex items-center justify-between gap-3.5 [&_h1]:mb-1.25 [&_h1]:text-[30px] [&_h1]:leading-[1.35] [&_h1]:font-[650] [&_h1]:tracking-[-1px] max-[620px]:[&_h1]:text-[27px] max-[620px]:[&_p]:text-[11px] max-[620px]:[&>button]:text-[10px]'>
            <div>
              <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
                Workflow orchestration
              </p>
              <h1>Overview</h1>
              <p className='text-[13px] text-muted-foreground'>Start a workflow. Follow every transition.</p>
            </div>
            <Button type='button' variant='outline' disabled={pending} onClick={refresh}>
              <RefreshCw
                className={pending ? 'animate-spin [animation-duration:1.5s] motion-reduce:animate-none' : ''}
              />
              Refresh
            </Button>
          </div>
          <div role='status' aria-live='polite' className='sr-only'>
            {pending ? 'Request in progress.' : message}
          </div>
          {error && (
            <div
              role='alert'
              className='mb-5 rounded-lg border border-[#edc8cc] bg-[#fff3f3] px-5 py-4 text-[#9b3e45] dark:border-[#945461] dark:bg-[#3c2228] dark:text-[#ffb4bf] [&_p]:mt-1 [&_p]:mb-3 [&_p]:text-[12px]'
            >
              <strong>Request could not be completed</strong>
              <p>{error}</p>
              <Button type='button' variant='outline' size='sm' disabled={pending} onClick={refresh}>
                Refresh persisted state
              </Button>
            </div>
          )}
          <div className='mb-[25px] grid grid-cols-4 gap-[15px] [&_[data-slot=card]]:shadow-[0_2px_3px_#253a2c03] max-[800px]:gap-2.5 max-[620px]:mb-[18px] max-[620px]:grid-cols-2'>
            <Card>
              <CardContent>
                <span className='flex items-center justify-between text-[11px] text-[#67776d] dark:text-muted-foreground [&_svg]:text-[#8a9e90] dark:[&_svg]:text-muted-foreground'>
                  Registered workflows
                  <Box size={16} />
                </span>
                <strong className='mt-2 mb-[3px] block text-[29px] leading-[1.4] font-[550] tracking-[-0.75px]'>
                  {Array.length(data.workflows)}
                </strong>
                <span className='text-[10px] text-[#8c9a90] dark:text-muted-foreground max-[800px]:text-[9px] max-[620px]:text-[10px]'>
                  Code-defined, versioned
                </span>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <span className='flex items-center justify-between text-[11px] text-[#67776d] dark:text-muted-foreground [&_svg]:text-[#8a9e90] dark:[&_svg]:text-muted-foreground'>
                  Total runs
                  <Activity size={16} />
                </span>
                <strong className='mt-2 mb-[3px] block text-[29px] leading-[1.4] font-[550] tracking-[-0.75px]'>
                  {Array.length(data.runs)}
                </strong>
                <span className='text-[10px] text-[#8c9a90] dark:text-muted-foreground max-[800px]:text-[9px] max-[620px]:text-[10px]'>
                  Persisted executions
                </span>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <span className='flex items-center justify-between text-[11px] text-[#67776d] dark:text-muted-foreground [&_svg]:text-[#8a9e90] dark:[&_svg]:text-muted-foreground'>
                  Waiting
                  <GitBranch size={16} />
                </span>
                <strong className='mt-2 mb-[3px] block text-[29px] leading-[1.4] font-[550] tracking-[-0.75px]'>
                  {waiting}
                </strong>
                <span className='text-[10px] text-[#8c9a90] dark:text-muted-foreground max-[800px]:text-[9px] max-[620px]:text-[10px]'>
                  Explicit resume required
                </span>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <span className='flex items-center justify-between text-[11px] text-[#67776d] dark:text-muted-foreground [&_svg]:text-[#8a9e90] dark:[&_svg]:text-muted-foreground'>
                  Completed
                  <Check size={16} />
                </span>
                <strong className='mt-2 mb-[3px] block text-[29px] leading-[1.4] font-[550] tracking-[-0.75px]'>
                  {completed}
                </strong>
                <span className='text-[10px] text-[#8c9a90] dark:text-muted-foreground max-[800px]:text-[9px] max-[620px]:text-[10px]'>
                  Terminal executions
                </span>
              </CardContent>
            </Card>
          </div>
          <section
            className={`mb-[27px] flex justify-between gap-5 rounded-[10px] border border-border bg-card p-[23px] max-[1100px]:items-start max-[620px]:mb-5 max-[620px]:flex-col max-[620px]:gap-[17px] max-[620px]:p-5 ${workflow && Array.length(workflow.inputs) > 0 ? 'flex-wrap items-start' : 'items-center'} [&>div]:flex [&>div]:items-center [&>div]:gap-[15px] max-[1100px]:[&>div]:gap-2.5 [&_label]:mr-[3px] [&_label]:text-[11px] [&_label]:text-[#75847a] dark:[&_label]:text-muted-foreground [&_h2]:mb-[3px] [&_button]:h-[33px] [&_button]:px-3.5 [&_button]:text-[12px] [&_input]:w-full [&_input]:min-w-0 [&_input]:rounded-md [&_input]:border [&_input]:border-border [&_input]:bg-card [&_input]:px-2.5 [&_input]:py-2 [&_input]:text-[12px] [&_textarea]:min-h-28 [&_textarea]:w-full [&_textarea]:min-w-0 [&_textarea]:resize-y [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-border [&_textarea]:bg-card [&_textarea]:px-2.5 [&_textarea]:py-2 [&_textarea]:text-[12px]`}
            data-has-inputs={Predicate.isNotUndefined(workflow) && Array.isReadonlyArrayNonEmpty(workflow.inputs)}
            aria-labelledby='launch-heading'
          >
            <div>
              <span className='grid size-[44px] place-items-center rounded-[9px] border border-[#e0ece3] bg-[#edf5ef] text-[#3c7457] dark:border-border dark:bg-secondary dark:text-[#b0e6c6] max-[1100px]:hidden'>
                <GitBranch size={20} />
              </span>
              <div>
                <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
                  Registered workflow
                </p>
                <h2 className='text-[17px] font-[620] tracking-[-0.35px]' id='launch-heading'>
                  {workflow?.name ?? 'No workflow registered'}
                </h2>
                <p className='text-[13px] text-muted-foreground max-[1100px]:text-[11px]'>
                  Each run keeps its starting version and immutable graph.
                </p>
              </div>
            </div>
            <form
              className={`gap-[9px] max-[1100px]:flex-wrap max-[1100px]:justify-end max-[620px]:w-full max-[620px]:justify-start ${workflow && Array.length(workflow.inputs) > 0 ? 'grid min-w-0 max-w-lg flex-[1_1_20rem] grid-cols-[minmax(0,1fr)] [&_button]:ml-0 [&_button]:justify-self-start' : 'flex shrink-0 items-center max-[620px]:[&_button]:ml-auto'}`}
              onSubmit={(event) => {
                event.preventDefault()
                start()
              }}
            >
              <label htmlFor='workflow-version'>Version</label>
              <select
                className='h-[33px] rounded-md border border-border bg-card py-1.5 pr-6 pl-2.5 text-[12px] text-[#485d4f] dark:text-foreground'
                id='workflow-version'
                value={version}
                disabled={pending || !workflow}
                onChange={(event) => {
                  setVersion(event.target.value)
                }}
              >
                {Array.map(workflow?.versions ?? [], (item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              {workflow &&
                Array.map(workflow.inputs, (input) => (
                  <Fragment key={input.name}>
                    <label htmlFor={input.name}>{input.label}</label>
                    {input.kind === 'textarea' ? (
                      <textarea
                        id={input.name}
                        name={input.name}
                        value={inputs[input.name] ?? ''}
                        placeholder={input.placeholder}
                        maxLength={input.maxLength}
                        required={input.required}
                        disabled={pending}
                        onChange={(event) => {
                          setInputs(Record.set(inputs, input.name, event.target.value))
                        }}
                      />
                    ) : (
                      <input
                        id={input.name}
                        name={input.name}
                        type='text'
                        value={inputs[input.name] ?? ''}
                        placeholder={input.placeholder}
                        maxLength={input.maxLength}
                        required={input.required}
                        disabled={pending}
                        onChange={(event) => {
                          setInputs(Record.set(inputs, input.name, event.target.value))
                        }}
                      />
                    )}
                  </Fragment>
                ))}
              <Button type='submit' disabled={pending || !workflow || !Array.contains(workflow.versions, version)}>
                <Play size={15} />
                Start run
              </Button>
            </form>
          </section>
          <div className='grid grid-cols-[260px_minmax(0,1fr)] items-start gap-[22px] min-[1500px]:grid-cols-[290px_minmax(0,1fr)] max-[1100px]:grid-cols-[215px_minmax(0,1fr)] max-[1100px]:gap-4 max-[800px]:grid-cols-[210px_minmax(0,1fr)] max-[800px]:gap-3.5 max-[620px]:grid-cols-[minmax(0,1fr)]'>
            <section
              className='min-w-0 overflow-hidden rounded-[10px] border border-border bg-card [&>div:first-child]:border-b [&>div:first-child]:border-[#edf0ee] [&>div:first-child]:px-[18px] [&>div:first-child]:pt-5 [&>div:first-child]:pb-4 dark:[&>div:first-child]:border-border'
              aria-labelledby='runs-heading'
            >
              <div className='flex items-center justify-between gap-3.5'>
                <div>
                  <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
                    Execution history
                  </p>
                  <h2 className='text-[17px] font-[620] tracking-[-0.35px]' id='runs-heading'>
                    Runs{' '}
                    <span className='ml-1 inline-flex min-w-[20px] items-center justify-center rounded-sm bg-[#edf2ee] px-1.25 align-middle text-[10px] leading-[18px] font-medium text-[#65816c] dark:bg-secondary dark:text-[#b0e6c6]'>
                      {Array.length(visibleRuns)}
                    </span>
                  </h2>
                </div>
                <span className='text-[11px] text-muted-foreground'>Newest first</span>
              </div>
              {Array.length(visibleRuns) === 0 ? (
                <div className='px-5 py-[45px] text-center text-[#8c9d91] dark:text-muted-foreground [&_svg]:mx-auto [&_svg]:mb-[15px] [&_h3]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-[#4e6656] dark:[&_h3]:text-foreground [&_p]:text-[12px]'>
                  <Activity size={28} />
                  <h3>No runs yet</h3>
                  <p>Choose a version and start the first run for this workflow.</p>
                </div>
              ) : (
                <ul
                  className='m-0 max-h-[650px] list-none overflow-y-auto p-0 max-[620px]:max-h-[270px] [&>li+li]:border-t [&>li+li]:border-[#edf0ee] dark:[&>li+li]:border-border'
                  aria-label='Persisted runs'
                >
                  {Array.map(visibleRuns, (run) => (
                    <li key={run.runId}>
                      <button
                        type='button'
                        className='block w-full border-0 border-l-[3px] border-l-transparent bg-card px-[15px] py-4 text-left transition-colors duration-150 hover:bg-[#f7faf8] aria-pressed:border-l-[#32845b] aria-pressed:bg-[#f0f7f2] dark:hover:bg-secondary dark:hover:text-[#b0e6c6] dark:aria-pressed:border-l-primary dark:aria-pressed:bg-secondary dark:aria-pressed:text-[#b0e6c6] max-[620px]:px-[18px] max-[620px]:py-3.5 [&_time]:block [&_time]:text-[9px] [&_time]:wrap-anywhere [&_time]:text-[#7d8c82] dark:[&_time]:text-muted-foreground'
                        aria-pressed={data.selected?.run.runId === run.runId}
                        disabled={pending}
                        onClick={() => {
                          chooseRun(run.runId)
                        }}
                      >
                        <span className='flex items-center justify-between gap-2 [&_code]:text-[12px] [&_code]:font-[550] [&_[data-slot=badge]]:text-[9px]'>
                          <code>#{shortId(run.runId)}</code>
                          <Badge variant='secondary'>{run.workflowVersion}</Badge>
                        </span>
                        <span className='mt-2.5 mb-2 flex items-center justify-between gap-2 max-[620px]:my-1.5 [&>svg]:text-[#8da494] dark:[&>svg]:text-muted-foreground'>
                          <RunStatus value={run.status} />
                          <ArrowRight size={14} />
                        </span>
                        <time dateTime={run.createdAt}>{run.createdAt}</time>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div className='min-w-0'>
              {data.selected ? (
                <SelectedRun key={data.selected.run.runId} detail={data.selected} pending={pending} onResume={resume} />
              ) : (
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
              )}
            </div>
          </div>
          <footer className='mt-[35px] flex justify-between gap-3 border-t border-[#e7ede9] pt-[17px] text-[9px] text-[#99a79e] dark:border-border dark:text-muted-foreground max-[620px]:flex-col max-[620px]:gap-1'>
            <span>Flowdeck · Effect-native orchestration</span>
            <span>Graph / State / Events</span>
          </footer>
        </main>
      </div>
    </div>
  )
}
