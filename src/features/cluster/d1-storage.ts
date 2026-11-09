import { ClusterMachine } from '@typeonce/effect-machine/cluster'
import { Effect, Layer, Option } from 'effect'
import { ClusterError, type EntityAddress } from 'effect/cluster'

import { AlchemyQueryExecutorLive, makeD1Queries } from '@/features/d1/reylo'

import { decodeRequestId, decodeSnapshot, encodeRequestId, encodeSnapshot } from './d1-storage-codecs'
import insertRequestQuery from './queries/insert-request.sql'
import loadQuery from './queries/load.sql'
import upsertCheckpointQuery from './queries/upsert-checkpoint.sql'

const persist = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new ClusterError.PersistenceError({ cause })),
    Effect.catchDefect((cause) => Effect.fail(new ClusterError.PersistenceError({ cause }))),
  )

const addressParams = (address: EntityAddress.EntityAddress) => ({
  shardGroup: address.shardId.group,
  shardId: address.shardId.id,
  entityType: address.entityType,
  entityId: address.entityId,
})

/**
 * Persists checkpoints and request deduplication only. Its independent D1 batch
 * does not join MessageStorage transactions or atomically persist emissions.
 * Use with non-emitting machines and without an enqueue handler.
 */
export const D1ClusterMachineStorage = Layer.effect(
  ClusterMachine.Storage,
  Effect.gen(function* () {
    const { run, prepare, batch } = yield* makeD1Queries
    return ClusterMachine.Storage.of({
      load: (address, requestId) =>
        persist(
          Effect.gen(function* () {
            const row = yield* run(loadQuery, {
              ...addressParams(address),
              requestId: yield* encodeRequestId(requestId),
            })
            if (!row) return { checkpoint: Option.none(), processed: false }
            return {
              checkpoint: Option.some({
                machineId: row.machineId,
                version: row.version,
                requestId: yield* decodeRequestId(row.requestId),
                snapshot: yield* decodeSnapshot(row.snapshotJson),
              }),
              processed: row.processed,
            }
          }),
        ),
      commit: (address, checkpoint) =>
        persist(
          Effect.gen(function* () {
            const identity = {
              ...addressParams(address),
              requestId: yield* encodeRequestId(checkpoint.requestId),
            }
            const writeCheckpoint = yield* prepare(upsertCheckpointQuery, {
              ...identity,
              machineId: checkpoint.machineId,
              version: checkpoint.version,
              snapshotJson: yield* encodeSnapshot(checkpoint.snapshot),
            })
            const writeRequest = yield* prepare(insertRequestQuery, identity)
            // Both insert and update paths are gated before the receipt is added.
            const results = yield* batch([writeCheckpoint, writeRequest])
            const changes = results[1]?.meta.changes
            if (changes === 1) return ClusterMachine.CommitResult.Committed()
            if (changes === 0) return ClusterMachine.CommitResult.Duplicate()
            return yield* Effect.fail(new Error('D1 returned an invalid request receipt change count'))
          }),
        ),
    })
  }),
).pipe(Layer.provide(AlchemyQueryExecutorLive))
