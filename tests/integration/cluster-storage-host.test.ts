import type { D1Database } from '@cloudflare/workers-types'
import { live } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { ClusterMachine } from '@typeonce/effect-machine/cluster'
import { Data, Effect, Layer, Predicate, Schema } from 'effect'
import { TestRunner } from 'effect/cluster'
import { describe, expect } from 'vite-plus/test'

import { machineId, openClusterStorage } from './cluster-storage.fixture.ts'

const Advance = Schema.TaggedStruct('Advance', {})
const StorageTestMachine = Machine.make({
  events: Machine.eventsFromSchemas(Advance),
  id: machineId,
  root: Machine.state({ states: { advanced: {}, completed: { type: 'final' }, ready: {} } }),
}).handle({
  initial: { target: 'ready' },
  states: {
    advanced: { on: { Advance: { target: 'completed' } } },
    completed: {},
    ready: { on: { Advance: { target: 'advanced' } } },
  },
})

// Use actual workerd D1 and the official Cluster messaging test host.
const openHost = Effect.fn('flowdeck.test.openClusterStorageHost')(function* (
  storageLayer: Layer.Layer<ClusterMachine.Storage>,
) {
  const machine = ClusterMachine.make('ClusterStorageTest', StorageTestMachine, { version: '1' })
  const dependencies = Layer.merge(storageLayer, TestRunner.layer)
  const context = yield* Layer.build(machine.toLayer().pipe(Layer.provideMerge(dependencies)))
  const send = Effect.gen(function* () {
    const client = yield* machine.entity.client
    return yield* client('storage-run').send(Advance.make({}))
  }).pipe(Effect.provideContext(context))
  return { send }
})

interface CheckpointRow {
  machine_id: string
  request_id: string
  snapshot_json: string
  version: string
}

const persisted = (database: D1Database): Effect.Effect<CheckpointRow | null> =>
  Effect.promise(async () =>
    database
      .prepare('SELECT machine_id, version, request_id, snapshot_json FROM cluster_machine_checkpoints')
      .first<CheckpointRow>(),
  )

class MissingCheckpoint extends Data.TaggedError('MissingCheckpoint')<{ message: string }> {}

const requireCheckpoint = Effect.fn('flowdeck.test.requireClusterCheckpoint')(function* (database: D1Database) {
  const row = yield* persisted(database)
  return Predicate.isNotNullish(row)
    ? row
    : yield* new MissingCheckpoint({ message: 'Expected a persisted D1 checkpoint' })
})

const SnapshotPaths = Schema.Struct({
  active: Schema.Array(Schema.Struct({ path: Schema.String })),
})
const decodeSnapshotPaths = Schema.decodeEffect(Schema.fromJsonString(SnapshotPaths))

const acceptInFreshHost = Effect.fn('flowdeck.test.acceptClusterEvent')(function* (
  storageLayer: Layer.Layer<ClusterMachine.Storage>,
) {
  const host = yield* openHost(storageLayer)
  return yield* host.send
}, Effect.scoped)

describe('cluster receipt rollback and host recovery', () => {
  live('rejects a failed receipt insert without partial persistence and recovers after host reconstruction', () =>
    Effect.gen(function* () {
      const { database, storageLayer } = yield* openClusterStorage
      yield* Effect.promise(async () =>
        database.exec(
          "CREATE TRIGGER reject_receipt BEFORE INSERT ON cluster_machine_requests BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END",
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const failed = yield* openHost(storageLayer)
          const result = yield* failed.send
          expect(result).toBeInstanceOf(ClusterMachine.Rejected)
          expect(result).toMatchObject({ reason: 'PersistenceFailure' })
          expect(yield* persisted(database)).toBeNull()
          const count = yield* Effect.promise(async () =>
            database.prepare('SELECT count(*) AS count FROM cluster_machine_requests').first(),
          )
          expect(count).toStrictEqual({ count: 0 })
        }),
      )
      yield* Effect.promise(async () => database.exec('DROP TRIGGER reject_receipt'))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const recovered = yield* openHost(storageLayer)
          expect(yield* recovered.send).toStrictEqual(new ClusterMachine.Accepted({}))
          const row = yield* requireCheckpoint(database)
          expect(row).toMatchObject({ machine_id: StorageTestMachine.id, version: '1' })
          expect(yield* decodeSnapshotPaths(row.snapshot_json)).toMatchObject({
            active: [{ path: '' }, { path: 'advanced' }],
          })
          const receipts = yield* Effect.promise(async () =>
            database.prepare('SELECT request_id FROM cluster_machine_requests').all(),
          )
          expect(receipts).toMatchObject({ results: [{ request_id: row.request_id }] })
        }),
      )
    }).pipe(Effect.scoped),
  )
})

describe('cluster checkpoint restoration', () => {
  live('resumes after host disposal and accepts final requests as no-ops', () =>
    Effect.gen(function* () {
      const { database, storageLayer } = yield* openClusterStorage
      expect(yield* acceptInFreshHost(storageLayer)).toStrictEqual(new ClusterMachine.Accepted({}))
      const afterFirst = yield* requireCheckpoint(database)
      expect(afterFirst).toMatchObject({ machine_id: StorageTestMachine.id, version: '1' })
      expect(yield* decodeSnapshotPaths(afterFirst.snapshot_json)).toMatchObject({
        active: [{ path: '' }, { path: 'advanced' }],
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const second = yield* openHost(storageLayer)
          expect(yield* second.send).toStrictEqual(new ClusterMachine.Accepted({}))
          const completed = yield* requireCheckpoint(database)
          expect(yield* decodeSnapshotPaths(completed.snapshot_json)).toMatchObject({
            active: [{ path: '' }, { path: 'completed' }],
          })
          expect(yield* second.send).toStrictEqual(new ClusterMachine.Accepted({}))
          const noop = yield* requireCheckpoint(database)
          expect(noop.snapshot_json).toBe(completed.snapshot_json)
          expect(noop.request_id).not.toBe(completed.request_id)
        }),
      )
    }).pipe(Effect.scoped),
  )
})

describe('incompatible cluster checkpoints', () => {
  live.each([
    ['version', 'VersionMismatch', "UPDATE cluster_machine_checkpoints SET version = 'other'"],
    ['identity', 'MachineIdMismatch', "UPDATE cluster_machine_checkpoints SET machine_id = 'other'"],
    [
      'machine state',
      'InvalidCheckpoint',
      `UPDATE cluster_machine_checkpoints SET snapshot_json = '{"_tag":"MachineSnapshot","version":2,"active":[{"path":"missing"}]}'`,
    ],
  ] as const)('rejects incompatible %s without changing persisted state', ([_label, reason, mutation]) =>
    Effect.gen(function* () {
      const { database, storageLayer } = yield* openClusterStorage
      expect(yield* acceptInFreshHost(storageLayer)).toStrictEqual(new ClusterMachine.Accepted({}))
      yield* Effect.promise(async () => database.exec(mutation))
      const before = yield* persisted(database)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const restored = yield* openHost(storageLayer)
          const result = yield* restored.send
          expect(result).toBeInstanceOf(ClusterMachine.Rejected)
          expect(result).toMatchObject({ reason })
        }),
      )
      expect(yield* persisted(database)).toStrictEqual(before)
    }).pipe(Effect.scoped),
  )
})
