import { Array, DateTime, Effect } from 'effect'

import { Conflict, NotFound } from '@/core/feature/workflow/domain/errors'

import { decodeAck, decodeCommand, decodeEventIds, encodeCommand, json, sqlNull } from './d1-store-codecs.ts'
import { DatabaseQueries } from './database-queries.ts'
import getAckQuery from './queries/get-ack.sql'
import insertEventQuery from './queries/insert-event.sql'
import insertReceiptQuery from './queries/insert-receipt.sql'
import updateRunQuery from './queries/update-run.sql'
import updateStateQuery from './queries/update-state.sql'
import type { CommitCommand } from './store.ts'

type CommitIdentity = Pick<CommitCommand, 'commitId' | 'runId'> & { commandJson: string }
type Prepare = DatabaseQueries['Service']['prepare']
interface CommitValues {
  command: CommitCommand
  identity: CommitIdentity
  snapshotJson: string
}

const revisionIncrement = 1

const validateCommit = Effect.fn(function* (command: CommitCommand) {
  yield* decodeCommand(command)
  const eventIds = Array.map(command.events, (event) => event.eventId)
  yield* decodeEventIds(eventIds).pipe(
    Effect.mapError(() => new Conflict({ message: 'Event IDs must be nonempty and unique within a commit' })),
  )
})

const prepareEvents = Effect.fn(function* (
  prepare: Prepare,
  identity: CommitIdentity,
  events: CommitCommand['events'],
) {
  return yield* Effect.forEach(events, (event, index) =>
    Effect.gen(function* () {
      const payloadJson = yield* json(event.payload)
      return yield* prepare(insertEventQuery, {
        ...identity,
        attempt: 'attempt' in event ? event.attempt : sqlNull,
        createdAt: DateTime.formatIso(event.createdAt),
        eventId: event.eventId,
        eventIndex: index,
        executionId: 'executionId' in event ? event.executionId : sqlNull,
        nodeId: 'nodeId' in event ? event.nodeId : sqlNull,
        payloadJson,
        type: event.type,
      })
    }),
  )
})

const prepareCommit = Effect.fn(function* (prepare: Prepare, { command, identity, snapshotJson }: CommitValues) {
  const revision = {
    ...identity,
    expectedRevision: command.expectedRevision,
    revision: command.expectedRevision + revisionIncrement,
  }
  const eventCount = Array.length(command.events)
  const receipt = yield* prepare(insertReceiptQuery, { ...revision, eventCount })
  const run = yield* prepare(updateRunQuery, {
    ...revision,
    eventCount,
    status: command.status,
    updatedAt: DateTime.formatIso(command.updatedAt),
  })
  const state = yield* prepare(updateStateQuery, { ...revision, snapshotJson })
  const events = yield* prepareEvents(prepare, identity, command.events)
  return [receipt, run, state, ...events]
})

export const makeCommit = Effect.gen(function* () {
  const { batch, prepare, read } = yield* DatabaseQueries
  return Effect.fn('D1Store.commit')(function* (command: CommitCommand) {
    yield* validateCommit(command)
    const snapshotJson = yield* json(command.snapshot)
    // Store the complete command to reject duplicate deliveries with changed data.
    const commandJson = yield* json(yield* encodeCommand(command))
    const identity = { commandJson, commitId: command.commitId, runId: command.runId }
    const statements = yield* prepareCommit(prepare, { command, identity, snapshotJson })
    yield* batch(statements)
    const ack = yield* read('read commit acknowledgement', getAckQuery, identity)
    if (!ack) {
      return yield* Effect.fail(new NotFound({ resource: `run:${command.runId}` }))
    }
    return yield* decodeAck(ack)
  })
})
