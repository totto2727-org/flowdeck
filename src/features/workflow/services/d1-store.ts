import { Array, DateTime, Effect, Layer, Match } from 'effect'

import { Conflict, NotFound } from '../domain/errors'
import type { GraphId, RunId } from '../domain/identity'
import type { GraphDefinition, Run } from '../domain/model'
import {
  decodeAck,
  decodeCommand,
  decodeDomainRun,
  decodeEventIds,
  decodeEventRow,
  decodeGraph,
  decodeGraphId,
  decodeRun,
  decodeRunId,
  encodeCommand,
  encodeVersion,
  fromJson,
  json,
} from './d1-store-codecs'
import { WorkflowDatabase } from './database'
import { all, batch, execute, first, prepare } from './database-queries'
import getAckQuery from './queries/get-ack.sql'
import getEventsQuery from './queries/get-events.sql'
import getGraphQuery from './queries/get-graph.sql'
import getRunQuery from './queries/get-run.sql'
import insertEventQuery from './queries/insert-event.sql'
import insertGraphQuery from './queries/insert-graph.sql'
import insertReceiptQuery from './queries/insert-receipt.sql'
import insertRunQuery from './queries/insert-run.sql'
import insertStateQuery from './queries/insert-state.sql'
import insertVersionQuery from './queries/insert-version.sql'
import insertWorkflowQuery from './queries/insert-workflow.sql'
import listRunsQuery from './queries/list-runs.sql'
import updateRunQuery from './queries/update-run.sql'
import updateStateQuery from './queries/update-state.sql'
import { type CommitCommand, type EventRange, Store, type StoreService } from './store'

const getRun = Effect.fn('D1Store.getRun')(function* (runId: RunId) {
  yield* decodeRunId(runId)
  const row = yield* execute('get run', first(getRunQuery, { runId }))
  if (!row) return yield* Effect.fail(new NotFound({ resource: `run:${runId}` }))
  return yield* decodeRun(row)
})

const create = Effect.fn('D1Store.create')(function* (run: Run, graph: GraphDefinition, workflowName: string) {
  yield* decodeDomainRun(run)
  yield* decodeGraph(graph)
  const version = yield* encodeVersion(run.workflowVersion)
  if (run.graphId !== graph.graphId || run.revision !== 0 || run.status !== 'pending') {
    return yield* Effect.fail(new Conflict({ message: 'New run must reference its graph with pending revision zero' }))
  }
  const graphJson = yield* json(graph)
  const snapshotJson = yield* json(run.snapshot)
  yield* batch([
    yield* prepare(insertWorkflowQuery, { workflowId: run.workflowId, name: workflowName }),
    yield* prepare(insertGraphQuery, { graphId: graph.graphId, schemaVersion: graph.schemaVersion, graphJson }),
    yield* prepare(insertVersionQuery, { workflowId: run.workflowId, version, graphId: graph.graphId }),
    yield* prepare(insertRunQuery, {
      runId: run.runId,
      workflowId: run.workflowId,
      workflowVersion: version,
      graphId: run.graphId,
      status: run.status,
      revision: run.revision,
      createdAt: DateTime.formatIso(run.createdAt),
      updatedAt: DateTime.formatIso(run.updatedAt),
    }),
    yield* prepare(insertStateQuery, { runId: run.runId, revision: run.revision, snapshotJson }),
  ])
})

const commit = Effect.fn('D1Store.commit')(function* (command: CommitCommand) {
  yield* decodeCommand(command)
  yield* decodeEventIds(Array.map(command.events, (event) => event.eventId)).pipe(
    Effect.mapError(() => new Conflict({ message: 'Event IDs must be nonempty and unique within a commit' })),
  )
  const snapshotJson = yield* json(command.snapshot)
  // Store the entire command, not just its ID, to reject mutated duplicate deliveries.
  const commandJson = yield* json(yield* encodeCommand(command))
  const identity = { commitId: command.commitId, runId: command.runId, commandJson }
  const revision = {
    ...identity,
    expectedRevision: command.expectedRevision,
    revision: command.expectedRevision + 1,
  }
  const receipt = yield* prepare(insertReceiptQuery, { ...revision, eventCount: Array.length(command.events) })
  const updateRun = yield* prepare(updateRunQuery, {
    ...revision,
    status: command.status,
    updatedAt: DateTime.formatIso(command.updatedAt),
    eventCount: Array.length(command.events),
  })
  const updateState = yield* prepare(updateStateQuery, { ...revision, snapshotJson })
  const events = yield* Effect.forEach(command.events, (event, index) =>
    Effect.gen(function* () {
      const payloadJson = yield* json(event.payload)
      return yield* prepare(insertEventQuery, {
        ...identity,
        eventId: event.eventId,
        eventIndex: index,
        nodeId: 'nodeId' in event ? event.nodeId : null,
        executionId: 'executionId' in event ? event.executionId : null,
        attempt: 'attempt' in event ? event.attempt : null,
        type: event.type,
        payloadJson,
        createdAt: DateTime.formatIso(event.createdAt),
      })
    }),
  )
  yield* batch([receipt, updateRun, updateState, ...events])
  const ack = yield* execute('read commit acknowledgement', first(getAckQuery, identity))
  if (!ack) return yield* Effect.fail(new NotFound({ resource: `run:${command.runId}` }))
  return yield* decodeAck(ack)
})

const listRuns = execute('list runs', all(listRunsQuery, {})).pipe(
  Effect.flatMap((rows) => Effect.forEach(rows, decodeRun)),
)

const getGraph = Effect.fn('D1Store.getGraph')(function* (graphId: GraphId) {
  yield* decodeGraphId(graphId)
  const row = yield* execute('get graph', first(getGraphQuery, { graphId }))
  if (!row) return yield* Effect.fail(new NotFound({ resource: `graph:${graphId}` }))
  return yield* decodeGraph(yield* fromJson(row.graph_json))
})

const getEvents = Effect.fn('D1Store.getEvents')(function* (runId: RunId, range: EventRange) {
  yield* decodeRunId(runId)
  const maxRevision = Match.value(range).pipe(
    Match.tag('All', () => null),
    Match.tag('ThroughRevision', ({ revision }) => revision),
    Match.exhaustive,
  )
  const rows = yield* execute('get events', all(getEventsQuery, { runId, maxRevision }))
  return yield* Effect.forEach(rows, decodeEventRow)
})

export const D1StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const database = yield* WorkflowDatabase
    return {
      create: (...args) => create(...args).pipe(Effect.provideService(WorkflowDatabase, database)),
      getRun: (...args) => getRun(...args).pipe(Effect.provideService(WorkflowDatabase, database)),
      listRuns: listRuns.pipe(Effect.provideService(WorkflowDatabase, database)),
      getGraph: (...args) => getGraph(...args).pipe(Effect.provideService(WorkflowDatabase, database)),
      getEvents: (...args) => getEvents(...args).pipe(Effect.provideService(WorkflowDatabase, database)),
      commit: (...args) => commit(...args).pipe(Effect.provideService(WorkflowDatabase, database)),
    } satisfies StoreService
  }),
)
