import type { D1Database } from '@cloudflare/workers-types'
import { Array, DateTime, Effect, Match, Schema, String } from 'effect'
import { Kysely, type Compilable } from 'kysely'
import { D1Dialect } from 'kysely-d1'

import { Conflict, NotFound, ExternalError } from '../domain/errors'
import { EventId, GraphId, RunId } from '../domain/identity'
import { GraphDefinition, JsonObject, Run, RunEvent } from '../domain/model'
import type { Database } from './database'
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

/** Kysely owns all query construction. D1's batch is the only transactional
 * adapter: D1 does not support Kysely's interactive transaction callback.
 * https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 */
export const makeD1Store = (database: D1Database): StoreService => {
  const db = new Kysely<Database>({ dialect: new D1Dialect({ database }) })
  const io = <A>(operation: string, evaluate: () => Promise<A>) =>
    Effect.tryPromise({ try: evaluate, catch: (cause) => databaseFailure(operation, cause) })
  const batch = (queries: ReadonlyArray<Compilable>) =>
    io('batch', () =>
      database.batch(
        Array.map(queries, (query) => {
          const compiled = query.compile()
          return database.prepare(compiled.sql).bind(...compiled.parameters)
        }),
      ),
    )
  const json = (value: Schema.Json) =>
    encodeJson(value).pipe(
      Effect.mapError((cause) => new ExternalError({ operation: 'encode persisted data', cause, kind: 'storage' })),
    )
  const fromJson = (value: string) =>
    decodeJson(value).pipe(
      Effect.mapError((cause) => new ExternalError({ operation: 'decode persisted JSON', cause, kind: 'storage' })),
    )
  const runsQuery = () =>
    db
      .selectFrom('runs')
      .innerJoin('run_states', 'runs.run_id', 'run_states.run_id')
      .select([
        'runs.run_id as runId',
        'workflow_id as workflowId',
        'workflow_version as workflowVersion',
        'graph_id as graphId',
        'status',
        'runs.revision as revision',
        'snapshot_json as snapshotJson',
        'created_at as createdAt',
        'updated_at as updatedAt',
      ])
  type RunRow = Awaited<ReturnType<ReturnType<typeof runsQuery>['execute']>>[number]
  const decodeRun = (row: RunRow) =>
    Effect.gen(function* () {
      const { snapshotJson, ...run } = row
      const snapshot = yield* fromJson(snapshotJson)
      return yield* decodePersistedRun({ ...run, snapshot })
    })

  const getRun = (runId: RunId) =>
    Effect.gen(function* () {
      yield* decodeRunId(runId)
      const row = yield* io('get run', () => runsQuery().where('runs.run_id', '=', runId).executeTakeFirst())
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
        db
          .insertInto('workflows')
          .values({ workflow_id: run.workflowId, name: workflowName })
          .onConflict((conflict) => conflict.column('workflow_id').doNothing()),
        db
          .insertInto('graphs')
          .values({ graph_id: graph.graphId, schema_version: graph.schemaVersion, graph_json: graphJson })
          .onConflict((conflict) => conflict.column('graph_id').doNothing()),
        db
          .insertInto('workflow_versions')
          .values({ workflow_id: run.workflowId, version, graph_id: graph.graphId })
          .onConflict((conflict) => conflict.columns(['workflow_id', 'version']).doNothing()),
        db.insertInto('runs').values({
          run_id: run.runId,
          workflow_id: run.workflowId,
          workflow_version: version,
          graph_id: run.graphId,
          status: run.status,
          revision: run.revision,
          created_at: DateTime.formatIso(run.createdAt),
          updated_at: DateTime.formatIso(run.updatedAt),
        }),
        db.insertInto('run_states').values({ run_id: run.runId, revision: run.revision, snapshot_json: snapshotJson }),
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
      const payloads = yield* Effect.forEach(command.events, (event) => json(event.payload))
      const nextRevision = command.expectedRevision + 1
      const receipt = db
        .insertInto('commit_receipts')
        .columns([
          'commit_id',
          'run_id',
          'expected_revision',
          'revision',
          'first_sequence',
          'event_count',
          'command_json',
        ])
        .expression((eb) =>
          eb
            .selectFrom('runs')
            .select((query) => [
              eb.val(command.commitId).as('commit_id'),
              'run_id',
              eb.val(command.expectedRevision).as('expected_revision'),
              eb.val(nextRevision).as('revision'),
              query('last_sequence', '+', 1).as('first_sequence'),
              eb.val(Array.length(command.events)).as('event_count'),
              eb.val(commandJson).as('command_json'),
            ])
            .where('run_id', '=', command.runId),
        )
        .onConflict((conflict) => conflict.column('commit_id').doNothing())
      const updateRun = db
        .updateTable('runs')
        .set((eb) => ({
          status: command.status,
          revision: nextRevision,
          updated_at: DateTime.formatIso(command.updatedAt),
          last_sequence: eb('last_sequence', '+', Array.length(command.events)),
        }))
        .where('run_id', '=', command.runId)
        .where('revision', '=', command.expectedRevision)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('commit_receipts')
              .select('commit_id')
              .where('commit_id', '=', command.commitId)
              .where('command_json', '=', commandJson),
          ),
        )
      const updateState = db
        .updateTable('run_states')
        .set({ revision: nextRevision, snapshot_json: snapshotJson })
        .where('run_id', '=', command.runId)
        .where('revision', '=', command.expectedRevision)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('commit_receipts')
              .select('commit_id')
              .where('commit_id', '=', command.commitId)
              .where('command_json', '=', commandJson),
          ),
        )
      const events = Array.map(command.events, (event, index) =>
        db
          .insertInto('run_events')
          .columns([
            'event_id',
            'run_id',
            'commit_id',
            'sequence',
            'node_id',
            'execution_id',
            'attempt',
            'type',
            'payload_json',
            'created_at',
          ])
          .expression((eb) =>
            eb
              .selectFrom('commit_receipts')
              .select((query) => [
                eb.val(event.eventId).as('event_id'),
                'run_id',
                'commit_id',
                query('first_sequence', '+', index).as('sequence'),
                eb.val('nodeId' in event ? event.nodeId : null).as('node_id'),
                eb.val('executionId' in event ? event.executionId : null).as('execution_id'),
                eb.val('attempt' in event ? event.attempt : null).as('attempt'),
                eb.val(event.type).as('type'),
                eb.val(payloads[index] ?? '{}').as('payload_json'),
                eb.val(DateTime.formatIso(event.createdAt)).as('created_at'),
              ])
              .where('commit_id', '=', command.commitId)
              .where('run_id', '=', command.runId)
              .where('command_json', '=', commandJson)
              // Identical redelivery skips only events belonging to that exact receipt.
              // Reusing another commit's event ID raises UNIQUE and rolls back the batch.
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('run_events')
                      .select('event_id')
                      .where('event_id', '=', event.eventId)
                      .where('commit_id', '=', command.commitId),
                  ),
                ),
              ),
          ),
      )
      yield* batch([receipt, updateRun, updateState, ...events])
      const ack = yield* io('read commit acknowledgement', () =>
        db
          .selectFrom('commit_receipts')
          .select([
            'commit_id as commitId',
            'run_id as runId',
            'revision',
            'first_sequence as firstSequence',
            'event_count as eventCount',
          ])
          .where('commit_id', '=', command.commitId)
          .where('run_id', '=', command.runId)
          .where('command_json', '=', commandJson)
          .executeTakeFirst(),
      )
      if (!ack) return yield* Effect.fail(new NotFound({ resource: `run:${command.runId}` }))
      return yield* decodeAck(ack)
    })

  return {
    create,
    getRun,
    listRuns: io('list runs', () => runsQuery().orderBy('created_at', 'desc').orderBy('runs.run_id').execute()).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRun)),
    ),
    getGraph: (graphId) =>
      Effect.gen(function* () {
        yield* decodeGraphId(graphId)
        const row = yield* io('get graph', () =>
          db.selectFrom('graphs').select('graph_json').where('graph_id', '=', graphId).executeTakeFirst(),
        )
        if (!row) return yield* Effect.fail(new NotFound({ resource: `graph:${graphId}` }))
        return yield* decodeGraph(yield* fromJson(row.graph_json))
      }),
    getEvents: (runId, range) =>
      Effect.gen(function* () {
        yield* decodeRunId(runId)
        const query = db
          .selectFrom('run_events')
          .innerJoin('commit_receipts', 'run_events.commit_id', 'commit_receipts.commit_id')
          .selectAll('run_events')
          .where('run_events.run_id', '=', runId)
        const selected = Match.value(range).pipe(
          Match.tag('All', () => query),
          Match.tag('ThroughRevision', ({ revision }) => query.where('commit_receipts.revision', '<=', revision)),
          Match.exhaustive,
        )
        const rows = yield* io('get events', () => selected.orderBy('sequence').execute())
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
