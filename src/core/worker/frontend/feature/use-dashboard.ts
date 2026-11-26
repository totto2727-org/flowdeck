import { Array, Function, Option, Predicate, Record } from 'effect'
import { useCallback, useState, useSyncExternalStore } from 'react'

import type { RunId } from '@/core/feature/workflow/domain/identity'

import { shortId } from './presentation.ts'
import { loadDashboard, resumeRun, selectRun, startRun } from './server.ts'
import type { DashboardData } from './server.ts'
import { useDashboardRequests } from './use-dashboard-requests.ts'
import type { WorkflowSummary } from './view-model.ts'

type Inputs = Record<string, string>

// SSR controls stay inert until React has attached their event handlers.
const subscribeHydration = (): (() => void) => Function.constVoid
const hydratedSnapshot = (): boolean => true
const serverSnapshot = (): boolean => false

type WorkflowSelection = Readonly<{
  changeInput: (name: string, value: string) => void
  choose: (workflow: WorkflowSummary) => void
  inputs: Inputs
  setVersion: (version: string) => void
  version: string
  workflowId: string
}>

const firstVersion = (item: WorkflowSummary | undefined): string =>
  Option.getOrUndefined(Array.head(item?.versions ?? [])) ?? ''

const useWorkflowSelection = (workflows: DashboardData['workflows'], setData: UpdateData): WorkflowSelection => {
  const firstWorkflow = Option.getOrUndefined(Array.head(workflows))
  const [workflowId, setWorkflowId] = useState(firstWorkflow?.workflowId ?? '')
  const [version, setVersion] = useState(firstVersion(firstWorkflow))
  const [inputs, setInputs] = useState<Inputs>({})
  const choose = useCallback(
    (item: WorkflowSummary): void => {
      setWorkflowId(item.workflowId)
      setVersion(firstVersion(item))
      setInputs({})
      // oxlint-disable-next-line unicorn/no-null -- DashboardData uses null for absent selection on the existing server contract.
      setData((current) => ({ ...current, selected: null }))
    },
    [setData, setInputs, setVersion, setWorkflowId],
  )
  const changeInput = useCallback((name: string, value: string): void => {
    setInputs((current) => Record.set(current, name, value))
  }, [])
  return { changeInput, choose, inputs, setVersion, version, workflowId }
}

export type DashboardController = Readonly<{
  canStart: boolean
  changeInput: WorkflowSelection['changeInput']
  chooseRun: (runId: RunId) => void
  chooseWorkflow: WorkflowSelection['choose']
  data: DashboardData
  error: string | undefined
  hydrated: boolean
  inputs: Inputs
  message: string
  pending: boolean
  refresh: () => void
  resume: () => void
  selectedRunId: RunId | undefined
  setVersion: WorkflowSelection['setVersion']
  start: () => void
  version: string
  workflow: WorkflowSummary | undefined
  workflowId: string
}>

type Invoke = ReturnType<typeof useDashboardRequests>['invoke']
type UpdateData = (update: (existing: DashboardData) => DashboardData) => void
type SetStatusMessage = (message: string) => void
type DashboardActionsContext = Readonly<{
  invoke: Invoke
  setData: (update: DashboardData | ((existing: DashboardData) => DashboardData)) => void
  setMessage: SetStatusMessage
}>

type ReadActions = Pick<DashboardController, 'chooseRun' | 'refresh'>

const useDashboardReads = (
  { invoke, setData, setMessage }: DashboardActionsContext,
  selectedRunId: RunId | undefined,
): ReadActions => {
  const refresh = useCallback((): void => {
    invoke(
      // oxlint-disable-next-line unicorn/no-null -- The loadDashboard input schema represents an absent run ID as null.
      async () => loadDashboard(selectedRunId ?? null),
      (value) => {
        setData(value)
        setMessage('Dashboard refreshed from the control plane.')
      },
    )
  }, [invoke, selectedRunId, setData, setMessage])

  const chooseRun = useCallback(
    (runId: RunId): void => {
      invoke(
        async () => selectRun(runId),
        (detail) => {
          setData((current) => ({ ...current, selected: detail }))
          setMessage(`Selected run ${shortId(runId)}.`)
        },
      )
    },
    [invoke, setData, setMessage],
  )

  return { chooseRun, refresh }
}

type RunActions = Pick<DashboardController, 'resume' | 'start'>
type RunCommands = Pick<DashboardController, 'canStart' | 'inputs' | 'selectedRunId' | 'version' | 'workflowId'>

const useDashboardRunActions = (
  { canStart, inputs, selectedRunId, version, workflowId }: RunCommands,
  { invoke, setData, setMessage }: DashboardActionsContext,
): RunActions => {
  const start = useCallback((): void => {
    if (!canStart) {
      return
    }
    const input = { ...inputs, version, workflowId }
    invoke(
      async () => startRun(input),
      ({ detail, runs }) => {
        setData((current) => ({ ...current, runs, selected: detail }))
        setMessage(`Started ${detail.run.workflowVersion} run ${shortId(detail.run.runId)}.`)
      },
    )
  }, [canStart, inputs, invoke, setData, setMessage, version, workflowId])

  const resume = useCallback((): void => {
    if (Predicate.isNullish(selectedRunId)) {
      return
    }
    invoke(
      async () => resumeRun(selectedRunId),
      ({ detail, runs }) => {
        setData((current) => ({ ...current, runs, selected: detail }))
        setMessage(`Run ${shortId(detail.run.runId)} is ${detail.run.status}.`)
      },
    )
  }, [invoke, selectedRunId, setData, setMessage])

  return { resume, start }
}

const currentWorkflow = (
  data: DashboardData,
  workflowId: string,
  version: string,
): Pick<DashboardController, 'canStart' | 'workflow'> => {
  const workflow = Option.getOrUndefined(Array.findFirst(data.workflows, (item) => item.workflowId === workflowId))
  return { canStart: Predicate.isNotNullish(workflow) && Array.contains(workflow.versions, version), workflow }
}

export const useDashboard = (initial: DashboardData): DashboardController => {
  const hydrated = useSyncExternalStore(subscribeHydration, hydratedSnapshot, serverSnapshot)
  const [data, setData] = useState(initial)
  const [message, setMessage] = useState('')
  const {
    changeInput,
    choose: chooseWorkflow,
    inputs,
    setVersion,
    version,
    workflowId,
  } = useWorkflowSelection(initial.workflows, setData)
  const { error, inFlight, invoke } = useDashboardRequests()
  const selectedRunId = data.selected?.run.runId
  const { canStart, workflow } = currentWorkflow(data, workflowId, version)
  const reads = useDashboardReads({ invoke, setData, setMessage }, selectedRunId)
  const actions = useDashboardRunActions(
    { canStart, inputs, selectedRunId, version, workflowId },
    { invoke, setData, setMessage },
  )

  return {
    ...reads,
    ...actions,
    canStart,
    changeInput,
    chooseWorkflow,
    data,
    error,
    hydrated,
    inputs,
    message,
    pending: !hydrated || inFlight,
    selectedRunId,
    setVersion,
    version,
    workflow,
    workflowId,
  }
}
