import type { RpcCallError, RpcDecodeError } from 'alchemy/Rpc'
import { Array, DateTime, Effect, Match, Option } from 'effect'

import { ExternalError, InvalidOperation } from '@/core/feature/workflow/domain/errors'
import { makeRunIdGenerator } from '@/core/feature/workflow/domain/identity'
import type { RunId, WorkflowId } from '@/core/feature/workflow/domain/identity'
import type { CreateRun, Run, RunDetail } from '@/core/feature/workflow/domain/model'
import { graphToShapes } from '@/core/feature/workflow/domain/projection'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'
import { EventRange, Store } from '@/core/feature/workflow/services/store'
import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import type { Workflows } from '@/core/feature/workflow/services/workflows'

// Alchemy's typed stub shape omits transport failures from its declared domain error channel.
const transportFailure = (cause: RpcCallError | RpcDecodeError): ExternalError =>
  new ExternalError({ cause, kind: 'service', operation: 'call workflow worker' })

const bindingFailure = (error: WorkflowFailure | RpcCallError | RpcDecodeError): WorkflowFailure =>
  Match.value(error).pipe(
    Match.tags({ RpcCallError: transportFailure, RpcDecodeError: transportFailure }),
    Match.orElse((failure) => failure),
  )

const makeRegisteredWorkflow = Effect.gen(function* () {
  const registry = yield* WorkflowRegistry
  return Effect.fn('Workflows.registeredWorkflow')(function* (workflowId: WorkflowId) {
    return yield* Array.findFirst(registry, (entry) => entry.summary.workflowId === workflowId).pipe(
      Option.match({
        onNone: () => Effect.fail(new InvalidOperation({ message: 'The workflow is not registered' })),
        onSome: Effect.succeed,
      }),
    )
  })
})

const makeListWorkflows = Effect.gen(function* () {
  const registry = yield* WorkflowRegistry
  return Effect.fn('Workflows.listWorkflows')(() =>
    Effect.succeed({ workflows: Array.map(registry, (entry) => entry.summary) }),
  )
})

const makeListRuns = Effect.gen(function* () {
  const store = yield* Store
  return Effect.fn('Workflows.listRuns')(function* () {
    return { runs: yield* store.listRuns }
  })
})

const makeGetRunDetail = Effect.gen(function* () {
  const store = yield* Store
  return Effect.fn('Workflows.getRunDetail')(function* (runId: RunId) {
    const run = yield* store.getRun(runId)
    const graph = yield* store.getGraph(run.graphId)
    // A revision-bounded prefix cannot include a newer checkpoint's events.
    const events = yield* store.getEvents(runId, EventRange.ThroughRevision({ revision: run.revision }))
    return {
      events,
      graph,
      run,
      shapes: graphToShapes(graph, events),
      state: { revision: run.revision, runId, snapshot: run.snapshot },
    } satisfies RunDetail
  })
})

const makeCreateRun = Effect.gen(function* () {
  const registeredWorkflow = yield* makeRegisteredWorkflow
  const store = yield* Store
  const newRunId = yield* makeRunIdGenerator
  const readDetail = yield* makeGetRunDetail
  return Effect.fn('Workflows.createRun')(function* (input: CreateRun) {
    const workflow = yield* registeredWorkflow(input.workflowId)
    // Workflow-owned validation must finish before any identity or persistence side effect.
    const prepared = yield* workflow.prepare(input)
    const runId = yield* newRunId()
    const now = yield* DateTime.now
    const run: Run = {
      createdAt: now,
      graphId: prepared.graph.graphId,
      revision: 0,
      runId,
      snapshot: prepared.snapshot,
      status: 'pending',
      updatedAt: now,
      workflowId: workflow.summary.workflowId,
      workflowVersion: input.version,
    }
    yield* store.create(run, prepared.graph, workflow.summary.name)
    // Persist first. A failed binding call leaves a recoverable pending run.
    yield* workflow.binding.start(runId).pipe(Effect.mapError(bindingFailure))
    return yield* readDetail(runId)
  })
})

const makeResumeRun = Effect.gen(function* () {
  const store = yield* Store
  const registeredWorkflow = yield* makeRegisteredWorkflow
  const readDetail = yield* makeGetRunDetail
  return Effect.fn('Workflows.resumeRun')(function* (runId: RunId) {
    const run = yield* store.getRun(runId)
    const workflow = yield* registeredWorkflow(run.workflowId)
    yield* workflow.binding.resume(runId).pipe(Effect.mapError(bindingFailure))
    return yield* readDetail(runId)
  })
})

export const listWorkflows = Effect.flatMap(makeListWorkflows, (list) => list())
export const listRuns = Effect.flatMap(makeListRuns, (list) => list())
export const getRunDetail = (
  runId: RunId,
): Effect.Effect<RunDetail, WorkflowFailure, Effect.Services<typeof makeGetRunDetail>> =>
  Effect.flatMap(makeGetRunDetail, (get) => get(runId))
export const createRun = (
  input: CreateRun,
): Effect.Effect<RunDetail, WorkflowFailure, Effect.Services<typeof makeCreateRun>> =>
  Effect.flatMap(makeCreateRun, (create) => create(input))
export const resumeRun = (
  runId: RunId,
): Effect.Effect<RunDetail, WorkflowFailure, Effect.Services<typeof makeResumeRun>> =>
  Effect.flatMap(makeResumeRun, (resume) => resume(runId))

/** Capture dependencies once so RPC methods do not depend on the caller's context. */
export const makeWorkflows = Effect.gen(function* () {
  const readCatalog = yield* makeListWorkflows
  const readRuns = yield* makeListRuns
  const readDetail = yield* makeGetRunDetail
  const startRun = yield* makeCreateRun
  const continueRun = yield* makeResumeRun
  return {
    createRun: startRun,
    getRunDetail: readDetail,
    listRuns: readRuns,
    listWorkflows: readCatalog,
    resumeRun: continueRun,
  } satisfies Workflows['Service']
})
