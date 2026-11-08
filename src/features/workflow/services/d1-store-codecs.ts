import { Effect, Schema } from 'effect'

import { ExternalError } from '@/features/workflow/domain/errors'
import { EventId, GraphId, RunId } from '@/features/workflow/domain/identity'
import { GraphDefinition, JsonObject, Run, RunEvent } from '@/features/workflow/domain/model'

import type getEventsQuery from './queries/get-events.sql'
import type getRunQuery from './queries/get-run.sql'
import { CommitAck, CommitCommand } from './store'

const EventIds = Schema.Array(EventId).check(Schema.isUnique())
const Json = Schema.fromJsonString(Schema.Json)
const encodeJson = Schema.encodeEffect(Json)
const decodeJson = Schema.decodeUnknownEffect(Json)
const encodeSemVer = Schema.encodeEffect(Schema.SemVerFromString)
const encodeCommitCommand = Schema.encodeEffect(Schema.toCodecJson(CommitCommand))
const storedDecoder = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })
  return (value: unknown) =>
    decode(value).pipe(
      Effect.mapError((cause) => new ExternalError({ operation: 'decode persisted data', cause, kind: 'storage' })),
    )
}

export const decodeRunId = storedDecoder(RunId)
export const decodeGraphId = storedDecoder(GraphId)
export const decodeDomainRun = storedDecoder(Run)
export const decodeGraph = storedDecoder(GraphDefinition)
export const decodeCommand = storedDecoder(CommitCommand)
export const decodeAck = storedDecoder(CommitAck)
export const decodeEventIds = Schema.decodeUnknownEffect(EventIds)
const decodePersistedRun = storedDecoder(Schema.toCodecJson(Run))
const decodeObject = storedDecoder(JsonObject)
const decodeEvent = storedDecoder(Schema.toCodecJson(RunEvent))

export const json = (value: Schema.Json) =>
  encodeJson(value).pipe(
    Effect.mapError((cause) => new ExternalError({ operation: 'encode persisted data', cause, kind: 'storage' })),
  )
export const fromJson = (value: string) =>
  decodeJson(value).pipe(
    Effect.mapError((cause) => new ExternalError({ operation: 'decode persisted JSON', cause, kind: 'storage' })),
  )
export const encodeVersion = (version: Run['workflowVersion']) =>
  encodeSemVer(version).pipe(
    Effect.mapError((cause) => new ExternalError({ operation: 'encode workflow version', cause, kind: 'storage' })),
  )
export const encodeCommand = (command: CommitCommand) =>
  encodeCommitCommand(command).pipe(
    Effect.mapError((cause) => new ExternalError({ operation: 'encode commit command', cause, kind: 'storage' })),
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
})
