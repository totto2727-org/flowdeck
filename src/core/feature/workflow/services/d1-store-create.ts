import { DateTime, Effect } from 'effect'

import { Conflict } from '@/core/feature/workflow/domain/errors'
import type { GraphDefinition, Run } from '@/core/feature/workflow/domain/model'

import { decodeDomainRun, decodeGraph, encodeVersion, json } from './d1-store-codecs.ts'
import { DatabaseQueries } from './database-queries.ts'
import insertGraphQuery from './queries/insert-graph.sql'
import insertRunQuery from './queries/insert-run.sql'
import insertStateQuery from './queries/insert-state.sql'
import insertVersionQuery from './queries/insert-version.sql'
import insertWorkflowQuery from './queries/insert-workflow.sql'

const initialRevision = 0

export const makeCreate = Effect.gen(function* () {
  const { batch, prepare } = yield* DatabaseQueries
  return Effect.fn('D1Store.create')(function* (run: Run, graph: GraphDefinition, workflowName: string) {
    yield* decodeDomainRun(run)
    yield* decodeGraph(graph)
    const version = yield* encodeVersion(run.workflowVersion)
    if (run.graphId !== graph.graphId || run.revision !== initialRevision || run.status !== 'pending') {
      return yield* Effect.fail(
        new Conflict({ message: 'New run must reference its graph with pending revision zero' }),
      )
    }
    const graphJson = yield* json(graph)
    const snapshotJson = yield* json(run.snapshot)
    const statements = [
      yield* prepare(insertWorkflowQuery, { name: workflowName, workflowId: run.workflowId }),
      yield* prepare(insertGraphQuery, { graphId: graph.graphId, graphJson, schemaVersion: graph.schemaVersion }),
      yield* prepare(insertVersionQuery, { graphId: graph.graphId, version, workflowId: run.workflowId }),
      yield* prepare(insertRunQuery, {
        createdAt: DateTime.formatIso(run.createdAt),
        graphId: run.graphId,
        revision: run.revision,
        runId: run.runId,
        status: run.status,
        updatedAt: DateTime.formatIso(run.updatedAt),
        workflowId: run.workflowId,
        workflowVersion: version,
      }),
      yield* prepare(insertStateQuery, { revision: run.revision, runId: run.runId, snapshotJson }),
    ]
    return yield* batch(statements).pipe(Effect.asVoid)
  })
})
