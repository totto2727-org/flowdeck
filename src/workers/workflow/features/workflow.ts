import type { RpcCallError, RpcDecodeError } from 'alchemy/Rpc'
import { Array, Crypto, DateTime, Effect, Option } from 'effect'

import { ExternalError, InvalidOperation, type DomainError } from '../../../features/workflow/domain/errors'
import { makeRunId } from '../../../features/workflow/domain/identity'
import type { CreateRun, Run, RunDetail } from '../../../features/workflow/domain/model'
import { graphToShapes } from '../../../features/workflow/domain/projection'
import { Store } from '../../../features/workflow/services/store'
import { WorkflowRegistry } from '../../../features/workflow/services/workflow-definition'
import type { Workflows } from '../../../features/workflow/services/workflows'

// Alchemy's typed stub shape omits transport failures from its declared domain error channel.
const bindingFailure = (error: DomainError | RpcCallError | RpcDecodeError) =>
  error._tag === 'RpcCallError' || error._tag === 'RpcDecodeError'
    ? new ExternalError({ operation: 'call workflow worker', kind: 'service', cause: error })
    : error

const registeredWorkflow = (workflowId: string) =>
  Effect.flatMap(WorkflowRegistry, (registry) =>
    Array.findFirst(registry, (entry) => entry.summary.workflowId === workflowId).pipe(
      Option.match({
        onNone: () => Effect.fail(new InvalidOperation({ message: 'The workflow is not registered' })),
        onSome: Effect.succeed,
      }),
    ),
  )

export const listWorkflows = Effect.map(WorkflowRegistry, (registry) => ({
  workflows: Array.map(registry, (entry) => entry.summary),
}))
export const listRuns = Effect.gen(function* () {
  const store = yield* Store
  return { runs: yield* store.listRuns }
})
export const getRunDetail = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.getRun(runId)
    const graph = yield* store.getGraph(run.graphId)
    // A revision-bounded prefix cannot include a newer checkpoint's events.
    const events = yield* store.getEvents(runId, { _tag: 'ThroughRevision', revision: run.revision })
    return {
      run,
      graph,
      state: { runId, revision: run.revision, snapshot: run.snapshot },
      events,
      shapes: graphToShapes(graph, events),
    } satisfies RunDetail
  })
export const createRun = (input: CreateRun) =>
  Effect.gen(function* () {
    const workflow = yield* registeredWorkflow(input.workflowId)
    // Workflow-owned validation must finish before any identity or persistence side effect.
    const prepared = yield* workflow.prepare(input)
    const store = yield* Store
    const runId = yield* makeRunId()
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
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
export const resumeRun = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.getRun(runId)
    const workflow = yield* registeredWorkflow(run.workflowId)
    yield* workflow.binding.resume(runId).pipe(Effect.mapError(bindingFailure))
    return yield* getRunDetail(runId)
  })

/** Capture dependencies once so RPC methods do not depend on the caller's context. */
export const makeWorkflows = Effect.gen(function* () {
  const context = yield* Effect.context<Store | Crypto.Crypto | WorkflowRegistry>()
  return {
    listWorkflows: () => listWorkflows.pipe(Effect.provideContext(context)),
    listRuns: () => listRuns.pipe(Effect.provideContext(context)),
    getRunDetail: (runId) => getRunDetail(runId).pipe(Effect.provideContext(context)),
    createRun: (input) => createRun(input).pipe(Effect.provideContext(context)),
    resumeRun: (runId) => resumeRun(runId).pipe(Effect.provideContext(context)),
  } satisfies Workflows['Service']
})
