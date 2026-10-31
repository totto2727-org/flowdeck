import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { Array, DateTime, Effect, Match, Schema, String } from 'effect'
import type { Cardinality, Query } from 'reylo'

import { Conflict, NotFound, ExternalError } from '../domain/errors'
import { EventId, GraphId, RunId } from '../domain/identity'
import { GraphDefinition, JsonObject, Run, RunEvent } from '../domain/model'
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
import { CommitAck, CommitCommand, type StoreService } from './store'

const EventIds = Schema.Array(EventId).check(Schema.isUnique())
const Json = Schema.fromJsonString(Schema.Json)
const encodeJson = Schema.encodeEffect(Json)
const decodeJson = Schema.decodeUnknownEffect(Json)
const PersistedRun = Schema.toCodecJson(Run)
const encodeVersion = Schema.encodeEffect(Schema.SemVerFromString)
const PersistedEvent = Schema.toCodecJson(RunEvent)
const encodeCommand = Schema.encodeEffect(Schema.toCodecJson(CommitCommand))
const storedDecoder = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })
  return (value: unknown) =>
    decode(value).pipe(
      Effect.mapError((cause) => new ExternalError({ operation: 'decode persisted data', cause, kind: 'storage' })),
    )
}
const decodeRunId = storedDecoder(RunId)
const decodeGraphId = storedDecoder(GraphId)
const decodeDomainRun = storedDecoder(Run)
const decodePersistedRun = storedDecoder(PersistedRun)
const decodeGraph = storedDecoder(GraphDefinition)
const decodeCommand = storedDecoder(CommitCommand)
const decodeAck = storedDecoder(CommitAck)
const decodeObject = storedDecoder(JsonObject)
const decodeEvent = storedDecoder(PersistedEvent)
const decodeEventIds = Schema.decodeUnknownEffect(EventIds)

const databaseFailure = (operation: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : 'Database operation failed'
  return String.includes('flowdeck_')(message) || String.includes('UNIQUE constraint')(message)
    ? new Conflict({ message })
    : new ExternalError({ operation, cause, kind: 'storage' })
}

/** Native D1 batch is required to commit receipt guards, checkpoints, and events atomically.
 * Reylo owns SQL compilation and parameter encoding through its compile API.
 * https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 */
export const makeD1Store = (database: D1Database): StoreService => {
  const io = <A>(operation: string, evaluate: () => Promise<A>) =>
    Effect.tryPromise({ try: evaluate, catch: (cause) => databaseFailure(operation, cause) })
  const prepare =
    <Input, Row, C extends Cardinality>(query: Query<Input, Row, C, 'sqlite'>, input: NoInfer<Input>) =>
    () => {
      const compiled = query.compile(input)
      return database.prepare(compiled.sql).bind(...compiled.parameters)
    }
  const batch = (queries: ReadonlyArray<() => D1PreparedStatement>) =>
    io('batch', () => database.batch(Array.map(queries, (query) => query())))
  const json = (value: Schema.Json) =>
    encodeJson(value).pipe(
      Effect.mapError((cause) => new ExternalError({ operation: 'encode persisted data', cause, kind: 'storage' })),
    )
  const fromJson = (value: string) =>
    decodeJson(value).pipe(
      Effect.mapError((cause) => new ExternalError({ operation: 'decode persisted JSON', cause, kind: 'storage' })),
    )
  type RunRow = (typeof getRunQuery)['~reylo']['element']
  const decodeRun = (row: RunRow) =>
    Effect.gen(function* () {
      const { snapshotJson, ...run } = row
      const snapshot = yield* fromJson(snapshotJson)
      return yield* decodePersistedRun({ ...run, snapshot })
    })

  const getRun = (runId: RunId) =>
    Effect.gen(function* () {
      yield* decodeRunId(runId)
      const row = yield* io('get run', () => getRunQuery.run(database, { runId }))
      if (!row) return yield* Effect.fail(new NotFound({ resource: `run:${runId}` }))
      return yield* decodeRun(row)
    })

  const create: StoreService['create'] = (run, graph, workflowName) =>
    Effect.gen(function* () {
      yield* decodeDomainRun(run)
      yield* decodeGraph(graph)
      const version = yield* encodeVersion(run.workflowVersion).pipe(
        Effect.mapError((cause) => new ExternalError({ operation: 'encode workflow version', cause, kind: 'storage' })),
      )
      if (run.graphId !== graph.graphId || run.revision !== 0 || run.status !== 'pending') {
        return yield* Effect.fail(
          new Conflict({ message: 'New run must reference its graph with pending revision zero' }),
        )
      }
      const graphJson = yield* json(graph)
      const snapshotJson = yield* json(run.snapshot)
      yield* batch([
        prepare(insertWorkflowQuery, { workflowId: run.workflowId, name: workflowName }),
        prepare(insertGraphQuery, { graphId: graph.graphId, schemaVersion: graph.schemaVersion, graphJson }),
        prepare(insertVersionQuery, { workflowId: run.workflowId, version, graphId: graph.graphId }),
        prepare(insertRunQuery, {
          runId: run.runId,
          workflowId: run.workflowId,
          workflowVersion: version,
          graphId: run.graphId,
          status: run.status,
          revision: run.revision,
          createdAt: DateTime.formatIso(run.createdAt),
          updatedAt: DateTime.formatIso(run.updatedAt),
        }),
        prepare(insertStateQuery, { runId: run.runId, revision: run.revision, snapshotJson }),
      ])
    })

  const commit: StoreService['commit'] = (command: CommitCommand) =>
    Effect.gen(function* () {
      yield* decodeCommand(command)
      yield* decodeEventIds(Array.map(command.events, (event) => event.eventId)).pipe(
        Effect.mapError(() => new Conflict({ message: 'Event IDs must be nonempty and unique within a commit' })),
      )
      const snapshotJson = yield* json(command.snapshot)
      // Store the entire command, not just its ID, to reject mutated duplicate deliveries.
      const encodedCommand = yield* encodeCommand(command).pipe(
        Effect.mapError((cause) => new ExternalError({ operation: 'encode commit command', cause, kind: 'storage' })),
      )
      const commandJson = yield* json(encodedCommand)
      const identity = { commitId: command.commitId, runId: command.runId, commandJson }
      const revision = {
        ...identity,
        expectedRevision: command.expectedRevision,
        revision: command.expectedRevision + 1,
      }
      const receipt = prepare(insertReceiptQuery, { ...revision, eventCount: Array.length(command.events) })
      const updateRun = prepare(updateRunQuery, {
        ...revision,
        status: command.status,
        updatedAt: DateTime.formatIso(command.updatedAt),
        eventCount: Array.length(command.events),
      })
      const updateState = prepare(updateStateQuery, { ...revision, snapshotJson })
      const events = yield* Effect.forEach(command.events, (event, index) =>
        Effect.map(json(event.payload), (payloadJson) =>
          prepare(insertEventQuery, {
            ...identity,
            eventId: event.eventId,
            eventIndex: index,
            nodeId: 'nodeId' in event ? event.nodeId : null,
            executionId: 'executionId' in event ? event.executionId : null,
            attempt: 'attempt' in event ? event.attempt : null,
            type: event.type,
            payloadJson,
            createdAt: DateTime.formatIso(event.createdAt),
          }),
        ),
      )
      yield* batch([receipt, updateRun, updateState, ...events])
      const ack = yield* io('read commit acknowledgement', () => getAckQuery.run(database, identity))
      if (!ack) return yield* Effect.fail(new NotFound({ resource: `run:${command.runId}` }))
      return yield* decodeAck(ack)
    })

  return {
    create,
    getRun,
    listRuns: io('list runs', () => listRunsQuery.run(database)).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRun)),
    ),
    getGraph: (graphId) =>
      Effect.gen(function* () {
        yield* decodeGraphId(graphId)
        const row = yield* io('get graph', () => getGraphQuery.run(database, { graphId }))
        if (!row) return yield* Effect.fail(new NotFound({ resource: `graph:${graphId}` }))
        return yield* decodeGraph(yield* fromJson(row.graph_json))
      }),
    getEvents: (runId, range) =>
      Effect.gen(function* () {
        yield* decodeRunId(runId)
        const maxRevision = Match.value(range).pipe(
          Match.tag('All', () => null),
          Match.tag('ThroughRevision', ({ revision }) => revision),
          Match.exhaustive,
        )
        const rows = yield* io('get events', () => getEventsQuery.run(database, { runId, maxRevision }))
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const payload = yield* decodeObject(yield* fromJson(row.payload_json))
            // SQL NULL represents absence only at this storage boundary, never in the domain event.
            const execution =
              row.node_id === null && row.execution_id === null && row.attempt === null
                ? {}
                : { nodeId: row.node_id, executionId: row.execution_id, attempt: row.attempt }
            return yield* decodeEvent({
              eventId: row.event_id,
              runId: row.run_id,
              sequence: row.sequence,
              ...execution,
              type: row.type,
              payload,
              createdAt: row.created_at,
            })
          }),
        )
      }),
    commit,
  }
}
