import { Crypto, Effect } from 'effect'

import type { CreateRun, Run, RunDetail } from '../domain/model'
import { graphToShapes } from '../domain/projection'
import { demoGraph, demoWorkflow, initialSnapshot } from '../workflows/demo'
import { timestamp } from '../workflows/node'
import { Store } from './store'
import { WorkflowBinding } from './workflow-binding'

export const listWorkflows = Effect.succeed({ workflows: [demoWorkflow] })
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
    const binding = yield* WorkflowBinding
    const crypto = yield* Crypto.Crypto
    const runId = yield* crypto.randomUUIDv4()
    const now = yield* timestamp
    const graph = demoGraph(input.version)
    const run: Run = {
      runId,
      workflowId: input.workflowId,
      workflowVersion: input.version,
      graphId: graph.graphId,
      status: 'pending',
      revision: 0,
      snapshot: initialSnapshot(input.version),
      createdAt: now,
      updatedAt: now,
    }
    yield* store.create(run, graph)
    // Persist first. A failed binding call leaves a recoverable pending run.
    yield* binding.start(runId)
    return yield* getRunDetail(runId)
  })
export const resumeRun = (runId: string) =>
  Effect.gen(function* () {
    const binding = yield* WorkflowBinding
    yield* binding.resume(runId)
    return yield* getRunDetail(runId)
  })
