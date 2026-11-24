import type { StandardQueryV1 } from '@totto2727/reylo'
import { ClusterMachine } from '@typeonce/effect-machine/cluster'
import { Data, Effect, Layer, Option } from 'effect'
import { ClusterError } from 'effect/cluster'
import type { EntityAddress } from 'effect/cluster'

import { AlchemyQueryExecutorLive, makeD1Queries } from '@/core/feature/d1/reylo'

import { decodeRequestId, decodeSnapshot, encodeRequestId, encodeSnapshot } from './d1-storage-codecs.ts'
import insertRequestQuery from './queries/insert-request.sql'
import loadQuery from './queries/load.sql'
import upsertCheckpointQuery from './queries/upsert-checkpoint.sql'

type AddressParams = Omit<StandardQueryV1.InferArgs<typeof loadQuery>[number], 'requestId'>
type Queries = Effect.Success<typeof makeD1Queries>
type Storage = ClusterMachine.Storage['Service']

class InvalidReceiptChangeCount extends Data.TaggedError('InvalidReceiptChangeCount')<{
  message: string
}> {}

const insertedReceipt = 1
const ignoredReceipt = 0

const persist = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ClusterError.PersistenceError, R> =>
  effect.pipe(
    Effect.mapError((cause) => new ClusterError.PersistenceError({ cause })),
    Effect.catchDefect((cause) => Effect.fail(new ClusterError.PersistenceError({ cause }))),
  )

const addressParams = (address: EntityAddress.EntityAddress): AddressParams => ({
  entityId: address.entityId,
  entityType: address.entityType,
  shardGroup: address.shardId.group,
  shardId: address.shardId.id,
})

const makeLoad =
  (run: Queries['run']): Storage['load'] =>
  (address, requestId) =>
    persist(
      Effect.gen(function* () {
        const row = yield* run(loadQuery, {
          ...addressParams(address),
          requestId: yield* encodeRequestId(requestId),
        })
        if (!row) {
          return { checkpoint: Option.none(), processed: false }
        }
        return {
          checkpoint: Option.some({
            machineId: row.machineId,
            requestId: yield* decodeRequestId(row.requestId),
            snapshot: yield* decodeSnapshot(row.snapshotJson),
            version: row.version,
          }),
          processed: row.processed,
        }
      }),
    )

const makeCommit =
  ({ batch, prepare }: Pick<Queries, 'batch' | 'prepare'>): Storage['commit'] =>
  (address, checkpoint) =>
    persist(
      Effect.gen(function* () {
        const identity = {
          ...addressParams(address),
          requestId: yield* encodeRequestId(checkpoint.requestId),
        }
        const writeCheckpoint = yield* prepare(upsertCheckpointQuery, {
          ...identity,
          machineId: checkpoint.machineId,
          snapshotJson: yield* encodeSnapshot(checkpoint.snapshot),
          version: checkpoint.version,
        })
        const writeRequest = yield* prepare(insertRequestQuery, identity)
        // Both insert and update paths are gated before the receipt is added.
        const [, receipt] = yield* batch([writeCheckpoint, writeRequest])
        const changes = receipt?.meta.changes
        if (changes === insertedReceipt) {
          return ClusterMachine.CommitResult.Committed()
        }
        if (changes === ignoredReceipt) {
          return ClusterMachine.CommitResult.Duplicate()
        }
        return yield* new InvalidReceiptChangeCount({ message: 'D1 returned an invalid request receipt change count' })
      }),
    )

/**
 * Persists checkpoints and request deduplication only. Its independent D1 batch
 * does not join MessageStorage transactions or atomically persist emissions.
 * Use with non-emitting machines and without an enqueue handler.
 */
export const D1ClusterMachineStorage = Layer.effect(
  ClusterMachine.Storage,
  Effect.gen(function* () {
    const { batch, prepare, run } = yield* makeD1Queries
    return ClusterMachine.Storage.of({
      commit: makeCommit({ batch, prepare }),
      load: makeLoad(run),
    })
  }),
).pipe(Layer.provide(AlchemyQueryExecutorLive))
