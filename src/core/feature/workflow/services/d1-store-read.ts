import { Effect, Match } from 'effect'

import { NotFound } from '@/core/feature/workflow/domain/errors'
import type { GraphId, RunId } from '@/core/feature/workflow/domain/identity'

import {
  decodeEventRow,
  decodeGraph,
  decodeGraphId,
  decodeRun,
  decodeRunId,
  fromJson,
  sqlNull,
} from './d1-store-codecs.ts'
import { DatabaseQueries } from './database-queries.ts'
import getEventsQuery from './queries/get-events.sql'
import getGraphQuery from './queries/get-graph.sql'
import getRunQuery from './queries/get-run.sql'
import listRunsQuery from './queries/list-runs.sql'
import type { EventRange } from './store.ts'

export const makeGetRun = Effect.gen(function* () {
  const { read } = yield* DatabaseQueries
  return Effect.fn('D1Store.getRun')(function* (runId: RunId) {
    yield* decodeRunId(runId)
    const row = yield* read('get run', getRunQuery, { runId })
    if (!row) {
      return yield* Effect.fail(new NotFound({ resource: `run:${runId}` }))
    }
    return yield* decodeRun(row)
  })
})

export const makeListRuns = Effect.gen(function* () {
  const { read } = yield* DatabaseQueries
  return read('list runs', listRunsQuery).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeRun)))
})

export const makeGetGraph = Effect.gen(function* () {
  const { read } = yield* DatabaseQueries
  return Effect.fn('D1Store.getGraph')(function* (graphId: GraphId) {
    yield* decodeGraphId(graphId)
    const row = yield* read('get graph', getGraphQuery, { graphId })
    if (!row) {
      return yield* Effect.fail(new NotFound({ resource: `graph:${graphId}` }))
    }
    return yield* decodeGraph(yield* fromJson(row.graph_json))
  })
})

export const makeGetEvents = Effect.gen(function* () {
  const { read } = yield* DatabaseQueries
  return Effect.fn('D1Store.getEvents')(function* (runId: RunId, range: EventRange) {
    yield* decodeRunId(runId)
    const maxRevision = Match.value(range).pipe(
      Match.tag('All', () => sqlNull),
      Match.tag('ThroughRevision', ({ revision }) => revision),
      Match.exhaustive,
    )
    const rows = yield* read('get events', getEventsQuery, { maxRevision, runId })
    return yield* Effect.forEach(rows, decodeEventRow)
  })
})
