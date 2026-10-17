'use client'

import { Array, Effect, Match, Option } from 'effect'
import { Activity, ArrowRight, Box, Check, ChevronRight, GitBranch, Layers, Play, RefreshCw } from 'lucide-react'
import { useState, useSyncExternalStore, useTransition } from 'react'

import type { RunDetail, RunEvent, WorkflowVersion } from '../../../features/workflow/domain/model'
import { Badge } from './components/generated/badge'
import { Button } from './components/generated/button'
import { Card, CardContent } from './components/generated/card'
import { NodeInspector, RunGraph } from './graph'
import { eventLabel, orderedEvents, renderJson, runRecoveryAction, shortId } from './presentation'
import { loadDashboard, resumeRun, selectRun, startRun, type DashboardData, type Result } from './server'

function Status({ value }: { readonly value: string }) {
  return (
    <Badge variant='outline' className={`status-badge status-${value}`}>
      <span className='status-dot' />
      {value}
    </Badge>
  )
}

function Events({
  events,
  selectedNode,
}: {
  readonly events: ReadonlyArray<RunEvent>
  readonly selectedNode: string | null
}) {
  const [nodeOnly, setNodeOnly] = useState(false)
  const visible = orderedEvents(
    nodeOnly && selectedNode ? Array.filter(events, (event) => event.nodeId === selectedNode) : events,
  )
  return (
    <section className='events-view' aria-label='Persisted events'>
      <div className='section-heading'>
        <p className='muted'>{Array.length(visible)} committed events · ordered by sequence</p>
        <label className='checkbox-label'>
          <input
            type='checkbox'
            checked={nodeOnly}
            disabled={selectedNode === null}
            onChange={(event) => setNodeOnly(event.target.checked)}
          />
          Selected node only
        </label>
      </div>
      {Array.length(visible) === 0 ? (
        <p className='empty-inline'>No events for this selection.</p>
      ) : (
        <ol className='event-list'>
          {Array.map(visible, (event) => (
            <li key={event.eventId}>
              <span className='event-sequence'>{event.sequence}</span>
              <details>
                <summary>
                  <span className='event-title'>{eventLabel(event.type)}</span>
                  <code>{event.nodeId ?? 'run'}</code>
                  <time dateTime={event.createdAt}>{event.createdAt}</time>
                </summary>
                <dl className='detail-grid'>
                  <div>
                    <dt>Event ID</dt>
                    <dd>
                      <code>{event.eventId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Execution ID</dt>
                    <dd>
                      <code>{event.executionId ?? 'Run event'}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Attempt</dt>
                    <dd>{event.attempt ?? 'Not applicable'}</dd>
                  </div>
                </dl>
                <pre className='json-view'>{renderJson(event.payload)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function SelectedRun({
  detail,
  pending,
  onResume,
}: {
  readonly detail: RunDetail
  readonly pending: boolean
  readonly onResume: () => void
}) {
  const [node, setNode] = useState<string | null>(null)
  const [view, setView] = useState<'events' | 'state'>('events')
  const recoveryAction = runRecoveryAction(detail.run.status)
  return (
    <>
      <section className='run-detail' aria-labelledby='selected-run-heading'>
        <div className='section-heading run-detail-heading'>
          <div>
            <p className='eyebrow'>Selected run</p>
            <h2 id='selected-run-heading'>
              Execution <span className='mono'>#{shortId(detail.run.runId)}</span>
            </h2>
          </div>
          <div className='inline-actions'>
            <Badge variant='secondary'>{detail.run.workflowVersion}</Badge>
            <Status value={detail.run.status} />
          </div>
        </div>
        <div className='run-metadata'>
          <span>
            <GitBranch size={14} />
            {detail.run.workflowId}
          </span>
          <span>Revision {detail.state.revision}</span>
          <span title={detail.run.graphId}>
            Graph <code>{shortId(detail.run.graphId)}</code>
          </span>
        </div>
        {recoveryAction !== null && (
          <div className='waiting-banner'>
            <div>
              <strong>
                {recoveryAction === 'resume' ? 'Waiting for an explicit resume' : 'Recover from committed state'}
              </strong>
              <p>
                {recoveryAction === 'resume'
                  ? `The committed state is retained. Resume continues this run with ${detail.run.workflowVersion}.`
                  : `If execution was interrupted, recover this run with ${detail.run.workflowVersion}. Review its committed state and events first.`}
              </p>
            </div>
            <Button type='button' disabled={pending} onClick={onResume}>
              <Play />
              {recoveryAction === 'resume' ? 'Resume run' : 'Recover run'}
            </Button>
          </div>
        )}
        <div className='graph-heading'>
          <span className='eyebrow'>Workflow topology</span>
          <div className='graph-legend'>
            <span>
              <i className='legend-dot' />
              Idle
            </span>
            <span>
              <i className='legend-dot active' />
              Active
            </span>
            <span>
              <i className='legend-dot success' />
              Succeeded
            </span>
            <span>
              <i className='legend-dot waiting' />
              Waiting
            </span>
          </div>
        </div>
        <RunGraph detail={detail} selectedNode={node} onSelect={setNode} />
        <NodeInspector detail={detail} nodeId={node} />
      </section>
      <section className='trace-panel' aria-labelledby='trace-heading'>
        <div className='section-heading'>
          <div>
            <p className='eyebrow'>Source of truth</p>
            <h2 id='trace-heading'>State & events</h2>
          </div>
          <div className='view-switch' aria-label='Trace view'>
            <Button
              type='button'
              size='sm'
              variant={view === 'events' ? 'secondary' : 'ghost'}
              aria-pressed={view === 'events'}
              onClick={() => setView('events')}
            >
              Events <span className='count-pill'>{Array.length(detail.events)}</span>
            </Button>
            <Button
              type='button'
              size='sm'
              variant={view === 'state' ? 'secondary' : 'ghost'}
              aria-pressed={view === 'state'}
              onClick={() => setView('state')}
            >
              State <span className='count-pill'>r{detail.state.revision}</span>
            </Button>
          </div>
        </div>
        {view === 'events' ? (
          <Events events={detail.events} selectedNode={node} />
        ) : (
          <div className='state-view'>
            <div className='section-heading'>
              <p className='muted'>Last committed snapshot · revision {detail.state.revision}</p>
              <Badge variant='outline'>Read only</Badge>
            </div>
            <pre className='json-view' aria-label='Committed run state'>
              {renderJson(detail.state.snapshot)}
            </pre>
          </div>
        )}
      </section>
    </>
  )
}

// SSR controls stay inert until React has attached their event handlers.
const subscribeHydration = () => () => undefined
const hydratedSnapshot = () => true
const serverSnapshot = () => false

export function Dashboard({ initial }: { readonly initial: DashboardData }) {
  const hydrated = useSyncExternalStore(subscribeHydration, hydratedSnapshot, serverSnapshot)
  const [data, setData] = useState(initial)
  const [workflowId, setWorkflowId] = useState(Option.getOrUndefined(Array.head(initial.workflows))?.workflowId ?? '')
  const [version, setVersion] = useState<WorkflowVersion>('v1')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [inFlight, transition] = useTransition()
  const pending = !hydrated || inFlight
  const workflow = Option.getOrUndefined(Array.findFirst(data.workflows, (item) => item.workflowId === workflowId))
  const visibleRuns = Array.filter(data.runs, (run) => run.workflowId === workflowId)
  const waiting = Array.length(Array.filter(data.runs, (run) => run.status === 'waiting'))
  const completed = Array.length(Array.filter(data.runs, (run) => run.status === 'completed'))
  const invoke = <A,>(call: () => Promise<Result<A>>, success: (value: A) => void) => {
    setError(null)
    transition(async () => {
      await Effect.runPromise(
        Effect.tryPromise({
          try: call,
          catch: () => 'The connection was interrupted. Refresh to check the current persisted state before retrying.',
        }).pipe(
          Effect.match({
            onFailure: setError,
            onSuccess: (result) => {
              if (result.ok) success(result.value)
              else setError(result.message)
            },
          }),
        ),
      )
    })
  }
  const refresh = () =>
    invoke(
      () => loadDashboard(data.selected?.run.runId ?? null),
      (value) => {
        setData(value)
        setMessage('Dashboard refreshed from the control plane.')
      },
    )
  const chooseRun = (runId: string) =>
    invoke(
      () => selectRun(runId),
      (detail) => {
        setData((current) => ({ ...current, selected: detail }))
        setMessage(`Selected run ${shortId(runId)}.`)
      },
    )
  const start = () => {
    if (workflowId !== 'demo') return
    invoke(
      () => startRun({ workflowId, version }),
      ({ detail, runs }) => {
        setData((current) => ({ ...current, runs, selected: detail }))
        setMessage(`Started ${detail.run.workflowVersion} run ${shortId(detail.run.runId)}.`)
      },
    )
  }
  const resume = () => {
    const runId = data.selected?.run.runId
    if (!runId) return
    invoke(
      () => resumeRun(runId),
      ({ detail, runs }) => {
        setData((current) => ({ ...current, runs, selected: detail }))
        setMessage(`Run ${shortId(detail.run.runId)} is ${detail.run.status}.`)
      },
    )
  }
  return (
    <div className='app-shell'>
      <a href='#main-content' className='skip-link'>
        Skip to dashboard
      </a>
      <aside className='sidebar' aria-label='Workflow navigation'>
        <a className='brand' href='/' aria-label='Flowdeck home'>
          <span className='brand-symbol'>
            <Layers size={21} />
          </span>
          flowdeck
        </a>
        <div className='workspace-label'>
          <span className='workspace-avatar'>F</span>
          <div>
            <strong>Control plane</strong>
            <span>Workflow workspace</span>
          </div>
        </div>
        <div className='nav-section-title'>Workspace</div>
        <a className='nav-item active-nav' href='#main-content'>
          <Activity size={17} />
          Overview
          <ChevronRight size={14} />
        </a>
        <div className='nav-section-title workflow-nav-title'>
          Workflows <span>{Array.length(data.workflows)}</span>
        </div>
        <nav aria-label='Registered workflows'>
          {Array.map(data.workflows, (item) => (
            <button
              key={item.workflowId}
              type='button'
              className={`nav-item workflow-nav ${workflowId === item.workflowId ? 'selected-nav' : ''}`}
              aria-pressed={workflowId === item.workflowId}
              disabled={pending}
              onClick={() => {
                setWorkflowId(item.workflowId)
                setVersion(Option.getOrElse(Array.head(item.versions), () => 'v1'))
                setData((current) => ({ ...current, selected: null }))
              }}
            >
              <Box size={16} />
              <span>{item.name}</span>
            </button>
          ))}
        </nav>
        <div className='sidebar-footer'>
          <span className='connection-dot' />
          <div>
            <strong>Workflow control</strong>
            <span>Static service binding</span>
          </div>
        </div>
      </aside>
      <div className='main-shell'>
        <header className='topbar'>
          <div className='breadcrumb'>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>Overview</strong>
          </div>
          <Badge variant='outline'>
            <span className='connection-dot' />
            Control API
          </Badge>
        </header>
        <main id='main-content' className='dashboard' aria-busy={pending}>
          <div className='page-heading'>
            <div>
              <p className='eyebrow'>Workflow orchestration</p>
              <h1>Overview</h1>
              <p className='muted'>Start a workflow. Follow every transition.</p>
            </div>
            <Button type='button' variant='outline' disabled={pending} onClick={refresh}>
              <RefreshCw className={pending ? 'spinning' : ''} />
              Refresh
            </Button>
          </div>
          <div role='status' aria-live='polite' className='sr-only'>
            {pending ? 'Request in progress.' : message}
          </div>
          {error && (
            <div role='alert' className='error-banner'>
              <strong>Request could not be completed</strong>
              <p>{error}</p>
              <Button type='button' variant='outline' size='sm' disabled={pending} onClick={refresh}>
                Refresh persisted state
              </Button>
            </div>
          )}
          <div className='stat-grid'>
            <Card>
              <CardContent>
                <span className='stat-label'>
                  Registered workflows
                  <Box size={16} />
                </span>
                <strong className='stat-value'>{Array.length(data.workflows)}</strong>
                <span className='stat-note'>Code-defined, versioned</span>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <span className='stat-label'>
                  Total runs
                  <Activity size={16} />
                </span>
                <strong className='stat-value'>{Array.length(data.runs)}</strong>
                <span className='stat-note'>Persisted executions</span>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <span className='stat-label'>
                  Waiting
                  <GitBranch size={16} />
                </span>
                <strong className='stat-value'>{waiting}</strong>
                <span className='stat-note'>Explicit resume required</span>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <span className='stat-label'>
                  Completed
                  <Check size={16} />
                </span>
                <strong className='stat-value'>{completed}</strong>
                <span className='stat-note'>Terminal executions</span>
              </CardContent>
            </Card>
          </div>
          <section className='launch-panel' aria-labelledby='launch-heading'>
            <div>
              <span className='launch-icon'>
                <GitBranch size={20} />
              </span>
              <div>
                <p className='eyebrow'>Registered workflow</p>
                <h2 id='launch-heading'>{workflow?.name ?? 'No workflow registered'}</h2>
                <p className='muted'>Each run keeps its starting version and immutable graph.</p>
              </div>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                start()
              }}
            >
              <label htmlFor='workflow-version'>Version</label>
              <select
                id='workflow-version'
                value={version}
                disabled={pending || !workflow}
                onChange={(event) =>
                  setVersion(
                    Match.value(event.target.value).pipe(
                      Match.when('v2', () => 'v2' as const),
                      Match.orElse(() => 'v1' as const),
                    ),
                  )
                }
              >
                {Array.map(workflow?.versions ?? [], (item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <Button type='submit' disabled={pending || workflow?.workflowId !== 'demo'}>
                <Play size={15} />
                Start run
              </Button>
            </form>
          </section>
          <div className='execution-layout'>
            <section className='runs-panel' aria-labelledby='runs-heading'>
              <div className='section-heading'>
                <div>
                  <p className='eyebrow'>Execution history</p>
                  <h2 id='runs-heading'>
                    Runs <span className='count-pill'>{Array.length(visibleRuns)}</span>
                  </h2>
                </div>
                <span className='muted text-small'>Newest first</span>
              </div>
              {Array.length(visibleRuns) === 0 ? (
                <div className='empty-state'>
                  <Activity size={28} />
                  <h3>No runs yet</h3>
                  <p>Choose a version and start the first run for this workflow.</p>
                </div>
              ) : (
                <ul className='run-list' aria-label='Persisted runs'>
                  {Array.map(visibleRuns, (run) => (
                    <li key={run.runId}>
                      <button
                        type='button'
                        className='run-row'
                        aria-pressed={data.selected?.run.runId === run.runId}
                        disabled={pending}
                        onClick={() => chooseRun(run.runId)}
                      >
                        <span className='run-row-top'>
                          <code>#{shortId(run.runId)}</code>
                          <Badge variant='secondary'>{run.workflowVersion}</Badge>
                        </span>
                        <span className='run-row-bottom'>
                          <Status value={run.status} />
                          <ArrowRight size={14} />
                        </span>
                        <time dateTime={run.createdAt}>{run.createdAt}</time>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div className='selected-panel'>
              {data.selected ? (
                <SelectedRun key={data.selected.run.runId} detail={data.selected} pending={pending} onResume={resume} />
              ) : (
                <section className='unselected-state'>
                  <span className='empty-graph-icon'>
                    <GitBranch size={34} />
                  </span>
                  <p className='eyebrow'>Execution explorer</p>
                  <h2>Your workflow, in focus.</h2>
                  <p>
                    Select a run to explore its graph, inspect node executions, and view committed state and events.
                  </p>
                  <span className='empty-hint'>No generated or preview data</span>
                </section>
              )}
            </div>
          </div>
          <footer className='page-footer'>
            <span>Flowdeck · Effect-native orchestration</span>
            <span>Graph / State / Events</span>
          </footer>
        </main>
      </div>
    </div>
  )
}
