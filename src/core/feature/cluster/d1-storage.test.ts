import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { live } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { ClusterMachine } from '@typeonce/effect-machine/cluster'
import { Array, Data, Effect, Exit, Fiber, Layer, Option, Predicate, Schema } from 'effect'
import { ClusterError, EntityAddress, EntityId, EntityType, ShardId, Snowflake, TestRunner } from 'effect/cluster'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vite-plus/test'

import { D1Client } from '@/core/feature/d1/client'
import { D1Binding, NativeD1Client } from '@/core/feature/d1/native'

import { D1ClusterMachineStorage } from './d1-storage.ts'

const isolatedExit = Effect.fn(function* <A, E>(effect: Effect.Effect<A, E>) {
  const fiber = yield* Effect.forkScoped(effect)
  return yield* Fiber.await(fiber)
})

// This data-only fixture verifies Cluster persistence independently of any application workflow runtime.
const Advance = Schema.TaggedStruct('Advance', {})
const StorageTestMachine = Machine.make({
  id: 'cluster-storage-test',
  root: Machine.state({ states: { ready: {}, advanced: {}, completed: { type: 'final' } } }),
  events: Machine.eventsFromSchemas(Advance),
}).handle({
  initial: { target: 'ready' },
  states: {
    ready: { on: { Advance: { target: 'advanced' } } },
    advanced: { on: { Advance: { target: 'completed' } } },
    completed: {},
  },
})

const address = (group = 'group', shard = 1, type = 'machine', id = 'run'): EntityAddress.EntityAddress =>
  EntityAddress.make({
    shardId: ShardId.make(group, shard),
    entityType: EntityType.make(type),
    entityId: EntityId.make(id),
  })
const request = Snowflake.Snowflake('9007199254740993')
const laterRequest = Snowflake.Snowflake('9007199254740995')
const checkpoint = (requestId = request, path = 'ready'): ClusterMachine.Checkpoint => ({
  machineId: 'cluster-storage-test',
  version: '1',
  requestId,
  snapshot: { _tag: 'MachineSnapshot', version: 2, active: [{ path }] },
})
let miniflare: Miniflare
let database: D1Database
let storageLayer: Layer.Layer<ClusterMachine.Storage>
const freshStorage = Effect.suspend(() => ClusterMachine.Storage.pipe(Effect.provide(storageLayer)))
const nativeClient = Effect.suspend(() => {
  const binding = Layer.succeed(D1Binding, database)
  const layers = NativeD1Client.pipe(Layer.provide(binding))
  return D1Client.pipe(Effect.provide(layers))
})

const storageWithClient = (client: D1Client['Service']): Effect.Effect<ClusterMachine.Storage['Service']> => {
  const provided = D1ClusterMachineStorage.pipe(Layer.provide(Layer.succeed(D1Client, client)))
  return ClusterMachine.Storage.pipe(Effect.provide(provided))
}

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default {}',
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'cluster-checkpoints' },
  })
  database = await miniflare.getD1Database('DB')
  const migrations = await readD1Migrations('migrations')
  await database.batch(
    Array.map(
      Array.flatMap(migrations, (migration) => migration.queries),
      (query) => database.prepare(query),
    ),
  )
  storageLayer = D1ClusterMachineStorage.pipe(
    Layer.provide(NativeD1Client),
    Layer.provide(Layer.succeed(D1Binding, database)),
  )
})
afterEach(async () => {
  await miniflare.dispose()
})

describe('d1 Cluster machine checkpoints', () => {
  test('requires only the captured D1 client', () => {
    expectTypeOf<Layer.Services<typeof D1ClusterMachineStorage>>().toEqualTypeOf<D1Client>()
  })

  live('loads an empty address without inventing a checkpoint or receipt', () =>
    Effect.gen(function* () {
      expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
        checkpoint: Option.none(),
        processed: false,
      })
    }),
  )

  live('restores the latest checkpoint and all earlier receipts from a new service without rounding snowflakes', () =>
    Effect.gen(function* () {
      const storage = yield* freshStorage
      expect(yield* storage.commit(address(), checkpoint())).toStrictEqual(ClusterMachine.CommitResult.Committed())
      expect(yield* storage.commit(address(), checkpoint(laterRequest, 'advanced'))).toStrictEqual(
        ClusterMachine.CommitResult.Committed(),
      )
      const restored = yield* freshStorage
      expect(yield* restored.load(address(), request)).toStrictEqual({
        checkpoint: Option.some(checkpoint(laterRequest, 'advanced')),
        processed: true,
      })
      expect(yield* restored.load(address(), Snowflake.Snowflake('9007199254740992'))).toStrictEqual({
        checkpoint: Option.some(checkpoint(laterRequest, 'advanced')),
        processed: false,
      })
      expect(
        yield* Effect.promise(async () =>
          database.prepare('SELECT request_id FROM cluster_machine_requests ORDER BY request_id').all(),
        ),
      ).toMatchObject({ results: [{ request_id: '9007199254740993' }, { request_id: '9007199254740995' }] })
      expect(yield* restored.commit(address(), checkpoint(request, 'completed'))).toStrictEqual(
        ClusterMachine.CommitResult.Duplicate(),
      )
      expect(yield* (yield* freshStorage).load(address(), laterRequest)).toStrictEqual({
        checkpoint: Option.some(checkpoint(laterRequest, 'advanced')),
        processed: true,
      })
    }),
  )

  live('commits with two native prepares and one batch without reads, then loads with one read', () =>
    Effect.gen(function* () {
      const client = yield* nativeClient
      const nativePrepare = client.prepare.bind(client)
      const read = vi.fn()
      const prepare = vi.spyOn(client, 'prepare').mockImplementation((sql) => {
        const statement = nativePrepare(sql)
        const nativeBind = statement.bind.bind(statement)
        vi.spyOn(statement, 'bind').mockImplementation((...values) => {
          const bound = nativeBind(...values)
          const nativeAll = bound.all.bind(bound)
          vi.spyOn(bound, 'all').mockImplementation(<T>() => {
            read()
            return nativeAll<T>()
          })
          return bound
        })
        return statement
      })
      const batch = vi.spyOn(client, 'batch')
      try {
        const storage = yield* storageWithClient(client)
        expect(yield* storage.commit(address(), checkpoint())).toStrictEqual(ClusterMachine.CommitResult.Committed())
        expect(prepare).toHaveBeenCalledTimes(2)
        expect(batch).toHaveBeenCalledOnce()
        expect(batch.mock.calls[0]?.[0]).toHaveLength(2)
        expect(read).not.toHaveBeenCalled()
        prepare.mockClear()
        batch.mockClear()
        expect(yield* storage.load(address(), request)).toStrictEqual({
          checkpoint: Option.some(checkpoint()),
          processed: true,
        })
        expect(prepare).toHaveBeenCalledOnce()
        expect(read).toHaveBeenCalledOnce()
        expect(batch).not.toHaveBeenCalled()
      } finally {
        prepare.mockRestore()
        batch.mockRestore()
      }
    }),
  )

  live('roundtrips every optional public snapshot field through a newly constructed storage service', () =>
    Effect.gen(function* () {
      const value: ClusterMachine.Checkpoint = {
        ...checkpoint(),
        snapshot: {
          _tag: 'MachineSnapshot',
          version: 2,
          active: [{ path: '' }, { path: 'ready', value: { nested: [null, true, 3, '日本語'], empty: {} } }],
          completed: [
            { path: 'first' },
            { path: 'second', output: null },
            { path: 'third', output: { result: [1, 'done'] } },
          ],
          history: {
            shallow: { mode: 'shallow', active: ['ready'], values: { ready: { draft: 'retained' } } },
            deep: { mode: 'deep', active: ['parent.child'], values: { 'parent.child': [false, null, 'saved'] } },
          },
        },
      }
      expect(yield* (yield* freshStorage).commit(address(), value)).toStrictEqual(
        ClusterMachine.CommitResult.Committed(),
      )
      expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
        checkpoint: Option.some(value),
        processed: true,
      })
    }),
  )

  live('commits exactly once for concurrent deliveries of the same request', () =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [(yield* freshStorage).commit(address(), checkpoint()), (yield* freshStorage).commit(address(), checkpoint())],
        {
          concurrency: 'unbounded',
        },
      )
      expect(results).toStrictEqual(
        expect.arrayContaining([ClusterMachine.CommitResult.Committed(), ClusterMachine.CommitResult.Duplicate()]),
      )
      yield* Effect.promise(async () =>
        expect(
          database.prepare('SELECT count(*) AS count FROM cluster_machine_requests').first(),
        ).resolves.toStrictEqual({
          count: 1,
        }),
      )
    }),
  )

  live.each([
    ['shard group', address('other')],
    ['shard id', address('group', 2)],
    ['entity type', address('group', 1, 'other')],
    ['entity id', address('group', 1, 'machine', 'other')],
    ['delimiter collision', address('group', 1, 'machine:run', 'tail')],
  ] as const)('isolates %s in the full address', ([_label, other]) =>
    Effect.gen(function* () {
      const first = _label === 'delimiter collision' ? address('group', 1, 'machine', 'run:tail') : address()
      const storage = yield* freshStorage
      yield* storage.commit(first, checkpoint())
      expect(yield* storage.load(other, request)).toStrictEqual({
        checkpoint: Option.none(),
        processed: false,
      })
      expect(yield* storage.commit(other, checkpoint(request, 'advanced'))).toStrictEqual(
        ClusterMachine.CommitResult.Committed(),
      )
      expect(yield* storage.load(first, request)).toStrictEqual({
        checkpoint: Option.some(checkpoint()),
        processed: true,
      })
    }),
  )

  live('rolls back the first checkpoint write when the receipt insert fails', () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () =>
        database.exec(
          "CREATE TRIGGER reject_receipt BEFORE INSERT ON cluster_machine_requests BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END",
        ),
      )
      const error = yield* (yield* freshStorage).commit(address(), checkpoint()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ClusterError.PersistenceError)
      expect(error.cause).toBeDefined()
      expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
        checkpoint: Option.none(),
        processed: false,
      })
      yield* Effect.promise(async () => database.exec('DROP TRIGGER reject_receipt'))
      expect(yield* (yield* freshStorage).commit(address(), checkpoint())).toStrictEqual(
        ClusterMachine.CommitResult.Committed(),
      )
    }),
  )

  live('preserves the earlier checkpoint and receipt when a later receipt insert aborts', () =>
    Effect.gen(function* () {
      yield* (yield* freshStorage).commit(address(), checkpoint())
      yield* Effect.promise(async () =>
        database.exec(
          "CREATE TRIGGER reject_receipt BEFORE INSERT ON cluster_machine_requests BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END",
        ),
      )
      expect(
        yield* (yield* freshStorage).commit(address(), checkpoint(laterRequest, 'advanced')).pipe(Effect.flip),
      ).toBeInstanceOf(ClusterError.PersistenceError)
      expect(yield* (yield* freshStorage).load(address(), laterRequest)).toStrictEqual({
        checkpoint: Option.some(checkpoint()),
        processed: false,
      })
      expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
        checkpoint: Option.some(checkpoint()),
        processed: true,
      })
    }),
  )

  live('retains native failure causes', () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => database.exec('DROP TABLE cluster_machine_requests'))
      const error = yield* (yield* freshStorage).commit(address(), checkpoint()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ClusterError.PersistenceError)
      expect(error.cause).toBeDefined()
      expect(String(error.cause)).toContain('cluster_machine_requests')
    }),
  )

  live('retains the exact captured client defect as the persistence cause', () =>
    Effect.gen(function* () {
      const cause = new Error('native batch failure')
      const storage = yield* storageWithClient({ ...(yield* nativeClient), batch: () => Effect.die(cause) })
      const error = yield* storage.commit(address(), checkpoint()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ClusterError.PersistenceError)
      expect(error.cause).toBe(cause)
      expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
        checkpoint: Option.none(),
        processed: false,
      })
    }),
  )

  live('does not reclassify batch interruption as persistence failure', () =>
    Effect.gen(function* () {
      const storage = yield* storageWithClient({ ...(yield* nativeClient), batch: () => Effect.interrupt })
      expect(Exit.hasInterrupts(yield* isolatedExit(storage.commit(address(), checkpoint())))).toBe(true)
      expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
        checkpoint: Option.none(),
        processed: false,
      })
    }),
  )

  live.each(['{}', '{"_tag":"MachineSnapshot","version":2,"active":[{"path":42}]}'])(
    'fails safely on malformed stored snapshot %s',
    (snapshot) =>
      Effect.gen(function* () {
        yield* (yield* freshStorage).commit(address(), checkpoint())
        yield* Effect.promise(async () =>
          database.prepare('UPDATE cluster_machine_checkpoints SET snapshot_json = ?').bind(snapshot).run(),
        )
        expect(yield* (yield* freshStorage).load(address(), request).pipe(Effect.flip)).toBeInstanceOf(
          ClusterError.PersistenceError,
        )
      }),
  )
})

// Use actual workerd D1 and the official Cluster messaging test host.
const openHost = Effect.gen(function* () {
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

const persisted = (): Effect.Effect<CheckpointRow | null> =>
  Effect.promise(async () =>
    database
      .prepare('SELECT machine_id, version, request_id, snapshot_json FROM cluster_machine_checkpoints')
      .first<CheckpointRow>(),
  )

class MissingCheckpoint extends Data.TaggedError('MissingCheckpoint')<{ message: string }> {}

const requireCheckpoint = Effect.gen(function* () {
  const row = yield* persisted()
  return Predicate.isNotNullish(row)
    ? row
    : yield* new MissingCheckpoint({ message: 'Expected a persisted D1 checkpoint' })
})

const SnapshotPaths = Schema.Struct({
  active: Schema.Array(Schema.Struct({ path: Schema.String })),
})
const decodeSnapshotPaths = Schema.decodeEffect(Schema.fromJsonString(SnapshotPaths))

const acceptInFreshHost = Effect.scoped(
  Effect.gen(function* () {
    const host = yield* openHost
    expect(yield* host.send).toStrictEqual(new ClusterMachine.Accepted({}))
  }),
)

describe('cluster receipt rollback and host recovery', () => {
  live('rejects a failed receipt insert without partial persistence and recovers after host reconstruction', () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () =>
        database.exec(
          "CREATE TRIGGER reject_receipt BEFORE INSERT ON cluster_machine_requests BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END",
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const failed = yield* openHost
          const result = yield* failed.send
          expect(result).toBeInstanceOf(ClusterMachine.Rejected)
          expect(result).toMatchObject({ reason: 'PersistenceFailure' })
          expect(yield* persisted()).toBeNull()
          const count = yield* Effect.promise(async () =>
            database.prepare('SELECT count(*) AS count FROM cluster_machine_requests').first(),
          )
          expect(count).toStrictEqual({ count: 0 })
        }),
      )
      yield* Effect.promise(async () => database.exec('DROP TRIGGER reject_receipt'))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const recovered = yield* openHost
          expect(yield* recovered.send).toStrictEqual(new ClusterMachine.Accepted({}))
          const row = yield* requireCheckpoint
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
    }),
  )
})

describe('cluster checkpoint restoration', () => {
  live('resumes after host disposal and accepts final requests as no-ops', () =>
    Effect.gen(function* () {
      yield* acceptInFreshHost
      const afterFirst = yield* requireCheckpoint
      expect(afterFirst).toMatchObject({ machine_id: StorageTestMachine.id, version: '1' })
      expect(yield* decodeSnapshotPaths(afterFirst.snapshot_json)).toMatchObject({
        active: [{ path: '' }, { path: 'advanced' }],
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const second = yield* openHost
          expect(yield* second.send).toStrictEqual(new ClusterMachine.Accepted({}))
          const completed = yield* requireCheckpoint
          expect(yield* decodeSnapshotPaths(completed.snapshot_json)).toMatchObject({
            active: [{ path: '' }, { path: 'completed' }],
          })
          expect(yield* second.send).toStrictEqual(new ClusterMachine.Accepted({}))
          const noop = yield* requireCheckpoint
          expect(noop.snapshot_json).toBe(completed.snapshot_json)
          expect(noop.request_id).not.toBe(completed.request_id)
        }),
      )
    }),
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
      yield* acceptInFreshHost
      yield* Effect.promise(async () => database.exec(mutation))
      const before = yield* persisted()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const restored = yield* openHost
          const result = yield* restored.send
          expect(result).toBeInstanceOf(ClusterMachine.Rejected)
          expect(result).toMatchObject({ reason })
        }),
      )
      expect(yield* persisted()).toStrictEqual(before)
    }),
  )
})
