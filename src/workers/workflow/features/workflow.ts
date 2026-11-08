import type { RpcCallError, RpcDecodeError } from 'alchemy/Rpc'
import { Array, DateTime, Effect, Option } from 'effect'

import { ExternalError, InvalidOperation, type DomainError } from '@/features/workflow/domain/errors'
import { makeRunIdGenerator, type RunId, type WorkflowId } from '@/features/workflow/domain/identity'
import type { CreateRun, Run, RunDetail } from '@/features/workflow/domain/model'
import { graphToShapes } from '@/features/workflow/domain/projection'
import { EventRange, Store } from '@/features/workflow/services/store'
import { WorkflowRegistry } from '@/features/workflow/services/workflow-definition'
import type { Workflows } from '@/features/workflow/services/workflows'

// Alchemy's typed stub shape omits transport failures from its declared domain error channel.
const bindingFailure = (error: DomainError | RpcCallError | RpcDecodeError) =>
  error._tag === 'RpcCallError' || error._tag === 'RpcDecodeError'
    ? new ExternalError({ operation: 'call workflow worker', kind: 'service', cause: error })
    : error

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
      run,
      graph,
      state: { runId, revision: run.revision, snapshot: run.snapshot },
      events,
      shapes: graphToShapes(graph, events),
    } satisfies RunDetail
  })
})

const makeCreateRun = Effect.gen(function* () {
  const registeredWorkflow = yield* makeRegisteredWorkflow
  const store = yield* Store
  const newRunId = yield* makeRunIdGenerator
  const getRunDetail = yield* makeGetRunDetail
  return Effect.fn('Workflows.createRun')(function* (input: CreateRun) {
    const workflow = yield* registeredWorkflow(input.workflowId)
    // Workflow-owned validation must finish before any identity or persistence side effect.
    const prepared = yield* workflow.prepare(input)
    const runId = yield* newRunId()
    const now = yield* DateTime.now
    const run: Run = {
      runId,
      workflowId: workflow.summary.workflowId,
      workflowVersion: input.version,
      graphId: prepared.graph.graphId,
      status: 'pending',
      revision: 0,
      snapshot: prepared.snapshot,
      createdAt: now,
      updatedAt: now,
    }
    yield* store.create(run, prepared.graph, workflow.summary.name)
    // Persist first. A failed binding call leaves a recoverable pending run.
    yield* workflow.binding.start(runId).pipe(Effect.mapError(bindingFailure))
    return yield* getRunDetail(runId)
  })
})

const makeResumeRun = Effect.gen(function* () {
  const store = yield* Store
  const registeredWorkflow = yield* makeRegisteredWorkflow
  const getRunDetail = yield* makeGetRunDetail
  return Effect.fn('Workflows.resumeRun')(function* (runId: RunId) {
    const run = yield* store.getRun(runId)
    const workflow = yield* registeredWorkflow(run.workflowId)
    yield* workflow.binding.resume(runId).pipe(Effect.mapError(bindingFailure))
    return yield* getRunDetail(runId)
  })
})

export const listWorkflows = Effect.flatMap(makeListWorkflows, (list) => list())
export const listRuns = Effect.flatMap(makeListRuns, (list) => list())
export const getRunDetail = (runId: RunId) => Effect.flatMap(makeGetRunDetail, (get) => get(runId))
export const createRun = (input: CreateRun) => Effect.flatMap(makeCreateRun, (create) => create(input))
export const resumeRun = (runId: RunId) => Effect.flatMap(makeResumeRun, (resume) => resume(runId))

/** Capture dependencies once so RPC methods do not depend on the caller's context. */
export const makeWorkflows = Effect.gen(function* () {
  return {
    listWorkflows: yield* makeListWorkflows,
    listRuns: yield* makeListRuns,
    getRunDetail: yield* makeGetRunDetail,
    createRun: yield* makeCreateRun,
    resumeRun: yield* makeResumeRun,
  } satisfies Workflows['Service']
})
