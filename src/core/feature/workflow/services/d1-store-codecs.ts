import { Array, Effect, Predicate, Schema } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { EventId, GraphId, RunId } from '@/core/feature/workflow/domain/identity'
import { GraphDefinition, JsonObject, Run, RunEvent } from '@/core/feature/workflow/domain/model'

import type getEventsQuery from './queries/get-events.sql'
import type getRunQuery from './queries/get-run.sql'
import { CommitAck, CommitCommand } from './store.ts'

const EventIds = Schema.Array(EventId).check(Schema.isUnique())
const Json = Schema.fromJsonString(Schema.Json)
const encodeJson = Schema.encodeEffect(Json)
const decodeJson = Schema.decodeEffect(Json)
const encodeSemVer = Schema.encodeEffect(Schema.SemVerFromString)
const encodeCommitCommand = Schema.encodeEffect(Schema.toCodecJson(CommitCommand))
const strictStorageShape = { onExcessProperty: 'error' } as const
const withStoredDataError =
  <Input, Output>(decode: (value: Input) => Effect.Effect<Output, Schema.SchemaError>) =>
  (value: Input): Effect.Effect<Output, ExternalError> =>
    decode(value).pipe(
      Effect.mapError((cause) => new ExternalError({ cause, kind: 'storage', operation: 'decode persisted data' })),
    )

export const decodeRunId = withStoredDataError(Schema.decodeEffect(RunId, strictStorageShape))
export const decodeGraphId = withStoredDataError(Schema.decodeEffect(GraphId, strictStorageShape))
export const decodeDomainRun = withStoredDataError(Schema.decodeEffect(Run, strictStorageShape))
export const decodeCommand = withStoredDataError(Schema.decodeEffect(CommitCommand, strictStorageShape))
export const decodeAck = withStoredDataError(Schema.decodeEffect(CommitAck, strictStorageShape))
export const decodeEventIds = Schema.decodeEffect(EventIds)

export const decodeGraph = withStoredDataError(
  // oxlint-disable-next-line rules/prefer-non-unknown-decode -- Persisted graph JSON has no validated domain shape until this decoder succeeds.
  Schema.decodeUnknownEffect(GraphDefinition, strictStorageShape),
)
const decodePersistedRun = withStoredDataError(
  // oxlint-disable-next-line rules/prefer-non-unknown-decode -- The SQL row and stored snapshot can contain invalid domain values and unknown JSON fields.
  Schema.decodeUnknownEffect(Schema.toCodecJson(Run), strictStorageShape),
)
const decodeObject = withStoredDataError(
  // oxlint-disable-next-line rules/prefer-non-unknown-decode -- Persisted payload JSON can still be a primitive or an array.
  Schema.decodeUnknownEffect(JsonObject, strictStorageShape),
)
const decodeEvent = withStoredDataError(
  // oxlint-disable-next-line rules/prefer-non-unknown-decode -- SQL yields raw event names and execution columns before the domain union validates them.
  Schema.decodeUnknownEffect(Schema.toCodecJson(RunEvent), strictStorageShape),
)

export const json = (value: Schema.Json): Effect.Effect<string, ExternalError> =>
  encodeJson(value).pipe(
    Effect.mapError((cause) => new ExternalError({ cause, kind: 'storage', operation: 'encode persisted data' })),
  )
export const fromJson = (value: string): Effect.Effect<Schema.Json, ExternalError> =>
  decodeJson(value).pipe(
    Effect.mapError((cause) => new ExternalError({ cause, kind: 'storage', operation: 'decode persisted JSON' })),
  )
export const encodeVersion = (version: Run['workflowVersion']): Effect.Effect<string, ExternalError> =>
  encodeSemVer(version).pipe(
    Effect.mapError((cause) => new ExternalError({ cause, kind: 'storage', operation: 'encode workflow version' })),
  )
export const encodeCommand = (command: CommitCommand): Effect.Effect<Schema.Json, ExternalError> =>
  encodeCommitCommand(command).pipe(
    Effect.mapError((cause) => new ExternalError({ cause, kind: 'storage', operation: 'encode commit command' })),
  )

export const decodeRun = Effect.fn('D1Store.decodeRun')(function* (row: (typeof getRunQuery)['~reylo']['element']) {
  const { snapshotJson, ...run } = row
  const snapshot = yield* fromJson(snapshotJson)
  return yield* decodePersistedRun({ ...run, snapshot })
})

export const decodeEventRow = Effect.fn('D1Store.decodeEventRow')(function* (
  row: (typeof getEventsQuery)['~reylo']['element'],
) {
  const payload = yield* decodeObject(yield* fromJson(row.payload_json))
  const columns = [row.node_id, row.execution_id, row.attempt]
  // oxlint-disable-next-line rules/prefer-is-nullish -- SQL NULL encodes an absent execution. Missing or mixed columns must fail domain validation.
  const execution = Array.every(columns, Predicate.isNull)
    ? {}
    : { attempt: row.attempt, executionId: row.execution_id, nodeId: row.node_id }
  return yield* decodeEvent({
    createdAt: row.created_at,
    eventId: row.event_id,
    payload,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    ...execution,
  })
})
