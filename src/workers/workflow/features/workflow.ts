import type { RpcCallError, RpcDecodeError } from 'alchemy/Rpc'
import { Crypto, Effect } from 'effect'

import { BindingError, InvalidOperation, type DomainError } from '../../../features/workflow/domain/errors'
import type { CreateRun, Run, RunDetail } from '../../../features/workflow/domain/model'
import { graphToShapes } from '../../../features/workflow/domain/projection'
import { Store } from '../../../features/workflow/services/store'
import type { Workflows } from '../../../features/workflow/services/workflows'
import { demoGraph, demoWorkflow, initialSnapshot } from '../../demo-workflow/features/demo'
import { timestamp } from '../../demo-workflow/features/node'
import {
  developmentGraph,
  developmentWorkflow,
  initialDevelopmentSnapshot,
} from '../../development-workflow/features/development'
import { DevelopmentWorkflowBinding, WorkflowBinding } from './workflow-binding'

// Alchemy's typed stub shape omits transport failures from its declared domain error channel.
const bindingFailure = (error: DomainError | RpcCallError | RpcDecodeError) =>
  error._tag === 'RpcCallError' || error._tag === 'RpcDecodeError' ? new BindingError({ cause: error }) : error

export const listWorkflows = Effect.succeed({ workflows: [demoWorkflow, developmentWorkflow] })
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
    const events = yield* store.getEvents(runId, run.revision)
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
    const store = yield* Store
    const binding = input.workflowId === 'demo' ? yield* WorkflowBinding : yield* DevelopmentWorkflowBinding
    const crypto = yield* Crypto.Crypto
    const runId = yield* crypto.randomUUIDv4()
    const now = yield* timestamp
    const graph = input.workflowId === 'demo' ? demoGraph(input.version) : developmentGraph
    const run: Run = {
      runId,
      workflowId: input.workflowId,
      workflowVersion: input.version,
      graphId: graph.graphId,
      status: 'pending',
      revision: 0,
      snapshot: input.workflowId === 'demo' ? initialSnapshot(input.version) : initialDevelopmentSnapshot(input),
      createdAt: now,
      updatedAt: now,
    }
    yield* store.create(run, graph)
    // Persist first. A failed binding call leaves a recoverable pending run.
    yield* binding.start(runId).pipe(Effect.mapError(bindingFailure))
    return yield* getRunDetail(runId)
  })
export const resumeRun = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.getRun(runId)
    if (run.workflowId !== 'demo' && run.workflowId !== 'jcode-development') {
      return yield* new InvalidOperation({ message: 'The persisted workflow is not registered' })
    }
    const binding = run.workflowId === 'jcode-development' ? yield* DevelopmentWorkflowBinding : yield* WorkflowBinding
    yield* binding.resume(runId).pipe(Effect.mapError(bindingFailure))
    return yield* getRunDetail(runId)
  })

/** Capture dependencies once so RPC methods do not depend on the caller's context. */
export const makeWorkflows = Effect.gen(function* () {
  const context = yield* Effect.context<Store | Crypto.Crypto | WorkflowBinding | DevelopmentWorkflowBinding>()
  return {
    listWorkflows: () => listWorkflows,
    listRuns: () => listRuns.pipe(Effect.provideContext(context)),
    getRunDetail: (runId) => getRunDetail(runId).pipe(Effect.provideContext(context)),
    createRun: (input) => createRun(input).pipe(Effect.provideContext(context)),
    resumeRun: (runId) => resumeRun(runId).pipe(Effect.provideContext(context)),
  } satisfies Workflows['Service']
})
