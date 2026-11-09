import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { ClusterMachine } from '@typeonce/effect-machine/cluster'
import { Array, Effect, Exit, Layer, ManagedRuntime, Option } from 'effect'
import { ClusterError, EntityAddress, EntityId, EntityType, ShardId, Snowflake, TestRunner } from 'effect/cluster'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { D1Client } from '@/features/d1/client'
import { D1Binding, NativeD1Client } from '@/features/d1/native'
import { DevelopmentMachine } from '@/workers/development-workflow/features/development-machine'

import { D1ClusterMachineStorage } from './d1-storage'

const address = (group = 'group', shard = 1, type = 'machine', id = 'run') =>
  EntityAddress.make({
    shardId: ShardId.make(group, shard),
    entityType: EntityType.make(type),
    entityId: EntityId.make(id),
  })
const request = Snowflake.Snowflake('9007199254740993')
const laterRequest = Snowflake.Snowflake('9007199254740995')
const checkpoint = (requestId = request, path = 'implement'): ClusterMachine.Checkpoint => ({
  machineId: 'jcode-development-1_0_0',
  version: '1',
  requestId,
  snapshot: { _tag: 'MachineSnapshot', version: 2, active: [{ path }] },
})
let miniflare: Miniflare
let database: D1Database
let storageLayer: Layer.Layer<ClusterMachine.Storage>
const freshStorage = () => Effect.runSync(ClusterMachine.Storage.pipe(Effect.provide(storageLayer)))
const nativeClient = () =>
  Effect.runSync(D1Client.pipe(Effect.provide(NativeD1Client.pipe(Layer.provide(Layer.succeed(D1Binding, database))))))

const storageWithClient = (client: D1Client['Service']) =>
  Effect.runSync(
    ClusterMachine.Storage.pipe(
      Effect.provide(D1ClusterMachineStorage.pipe(Layer.provide(Layer.succeed(D1Client, client)))),
    ),
  )

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

describe('D1 Cluster machine checkpoints', () => {
  it('requires only the captured D1 client', () => {
    expectTypeOf<Layer.Services<typeof D1ClusterMachineStorage>>().toEqualTypeOf<D1Client>()
  })

  it('loads an empty address without inventing a checkpoint or receipt', async () => {
    expect(await Effect.runPromise(freshStorage().load(address(), request))).toEqual({
      checkpoint: Option.none(),
      processed: false,
    })
  })

  it('restores the latest checkpoint and all earlier receipts from a new service without rounding snowflakes', async () => {
    const storage = freshStorage()
    expect(await Effect.runPromise(storage.commit(address(), checkpoint()))).toEqual(
      ClusterMachine.CommitResult.Committed(),
    )
    expect(await Effect.runPromise(storage.commit(address(), checkpoint(laterRequest, 'verify')))).toEqual(
      ClusterMachine.CommitResult.Committed(),
    )
    const restored = freshStorage()
    expect(await Effect.runPromise(restored.load(address(), request))).toEqual({
      checkpoint: Option.some(checkpoint(laterRequest, 'verify')),
      processed: true,
    })
    expect(await Effect.runPromise(restored.load(address(), Snowflake.Snowflake('9007199254740992')))).toEqual({
      checkpoint: Option.some(checkpoint(laterRequest, 'verify')),
      processed: false,
    })
    expect(
      await database.prepare('SELECT request_id FROM cluster_machine_requests ORDER BY request_id').all(),
    ).toMatchObject({ results: [{ request_id: '9007199254740993' }, { request_id: '9007199254740995' }] })
    expect(await Effect.runPromise(restored.commit(address(), checkpoint(request, 'completed')))).toEqual(
      ClusterMachine.CommitResult.Duplicate(),
    )
    expect(await Effect.runPromise(freshStorage().load(address(), laterRequest))).toEqual({
      checkpoint: Option.some(checkpoint(laterRequest, 'verify')),
      processed: true,
    })
  })

  it('commits exactly once for concurrent deliveries of the same request', async () => {
    const results = await Effect.runPromise(
      Effect.all([freshStorage().commit(address(), checkpoint()), freshStorage().commit(address(), checkpoint())], {
        concurrency: 'unbounded',
      }),
    )
    expect(results).toEqual(
      expect.arrayContaining([ClusterMachine.CommitResult.Committed(), ClusterMachine.CommitResult.Duplicate()]),
    )
    expect(await database.prepare('SELECT count(*) AS count FROM cluster_machine_requests').first()).toEqual({
      count: 1,
    })
  })

  it.each([
    ['shard group', address('other')],
    ['shard id', address('group', 2)],
    ['entity type', address('group', 1, 'other')],
    ['entity id', address('group', 1, 'machine', 'other')],
    ['delimiter collision', address('group', 1, 'machine:run', 'tail')],
  ])('isolates %s in the full address', async (_label, other) => {
    const first = _label === 'delimiter collision' ? address('group', 1, 'machine', 'run:tail') : address()
    const storage = freshStorage()
    await Effect.runPromise(storage.commit(first, checkpoint()))
    expect(await Effect.runPromise(storage.load(other, request))).toEqual({
      checkpoint: Option.none(),
      processed: false,
    })
    expect(await Effect.runPromise(storage.commit(other, checkpoint(request, 'verify')))).toEqual(
      ClusterMachine.CommitResult.Committed(),
    )
    expect(await Effect.runPromise(storage.load(first, request))).toEqual({
      checkpoint: Option.some(checkpoint()),
      processed: true,
    })
  })

  it('rolls back the first checkpoint write when the receipt insert fails', async () => {
    await database.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON cluster_machine_requests BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END",
    )
    const error = await Effect.runPromise(freshStorage().commit(address(), checkpoint()).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ClusterError.PersistenceError)
    expect(error.cause).toBeDefined()
    expect(await Effect.runPromise(freshStorage().load(address(), request))).toEqual({
      checkpoint: Option.none(),
      processed: false,
    })
    await database.exec('DROP TRIGGER reject_receipt')
    expect(await Effect.runPromise(freshStorage().commit(address(), checkpoint()))).toEqual(
      ClusterMachine.CommitResult.Committed(),
    )
  })

  it('preserves the earlier checkpoint and receipt when a later receipt insert aborts', async () => {
    await Effect.runPromise(freshStorage().commit(address(), checkpoint()))
    await database.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON cluster_machine_requests BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END",
    )
    expect(
      await Effect.runPromise(freshStorage().commit(address(), checkpoint(laterRequest, 'verify')).pipe(Effect.flip)),
    ).toBeInstanceOf(ClusterError.PersistenceError)
    expect(await Effect.runPromise(freshStorage().load(address(), laterRequest))).toEqual({
      checkpoint: Option.some(checkpoint()),
      processed: false,
    })
    expect(await Effect.runPromise(freshStorage().load(address(), request))).toEqual({
      checkpoint: Option.some(checkpoint()),
      processed: true,
    })
  })

  it('retains native failure causes', async () => {
    await database.exec('DROP TABLE cluster_machine_requests')
    const error = await Effect.runPromise(freshStorage().commit(address(), checkpoint()).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ClusterError.PersistenceError)
    expect(error.cause).toBeDefined()
    expect(String(error.cause)).toContain('cluster_machine_requests')
  })

  it('retains the exact captured client defect as the persistence cause', async () => {
    const cause = new Error('native batch failure')
    const storage = storageWithClient({ ...nativeClient(), batch: () => Effect.die(cause) })
    const error = await Effect.runPromise(storage.commit(address(), checkpoint()).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ClusterError.PersistenceError)
    expect(error.cause).toBe(cause)
    expect(await Effect.runPromise(freshStorage().load(address(), request))).toEqual({
      checkpoint: Option.none(),
      processed: false,
    })
  })

  it('does not reclassify batch interruption as persistence failure', async () => {
    const storage = storageWithClient({ ...nativeClient(), batch: () => Effect.interrupt })
    expect(Exit.hasInterrupts(await Effect.runPromiseExit(storage.commit(address(), checkpoint())))).toBe(true)
    expect(await Effect.runPromise(freshStorage().load(address(), request))).toEqual({
      checkpoint: Option.none(),
      processed: false,
    })
  })

  it.each(['{}', '{"_tag":"MachineSnapshot","version":2,"active":[{"path":42}]}'])(
    'fails safely on malformed stored snapshot %s',
    async (snapshot) => {
      await Effect.runPromise(freshStorage().commit(address(), checkpoint()))
      await database.prepare('UPDATE cluster_machine_checkpoints SET snapshot_json = ?').bind(snapshot).run()
      expect(await Effect.runPromise(freshStorage().load(address(), request).pipe(Effect.flip))).toBeInstanceOf(
        ClusterError.PersistenceError,
      )
    },
  )
})

// Official TestRunner is the local messaging host, not deployed Cluster acceptance.
// D1 is real workerd storage. No handler internals or memory checkpoint service are substituted.
const host = () => {
  const machine = ClusterMachine.make('DevelopmentStorageTest', DevelopmentMachine, { version: '1' })
  const dependencies = Layer.merge(storageLayer, TestRunner.layer)
  const runtime = ManagedRuntime.make(machine.toLayer().pipe(Layer.provideMerge(dependencies)))
  return {
    runtime,
    send: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const client = yield* machine.entity.client
          return yield* client('development-run').send({ _tag: 'Done', context: {} })
        }),
      ),
  }
}
const persisted = () =>
  database
    .prepare('SELECT machine_id, version, request_id, snapshot_json FROM cluster_machine_checkpoints')
    .first<{ machine_id: string; version: string; request_id: string; snapshot_json: string }>()

describe('official Cluster machine with D1 checkpoint storage', () => {
  it('resumes DevelopmentMachine after host disposal and accepts final requests as no-ops', async () => {
    const first = host()
    try {
      expect(await first.send()).toEqual(new ClusterMachine.Accepted({}))
    } finally {
      await first.runtime.dispose()
    }
    const afterFirst = await persisted()
    expect(afterFirst).toMatchObject({ machine_id: DevelopmentMachine.id, version: '1' })
    expect(JSON.parse(afterFirst!.snapshot_json)).toMatchObject({ active: [{ path: '' }, { path: 'verify' }] })
    const second = host()
    try {
      expect(await second.send()).toEqual(new ClusterMachine.Accepted({}))
      const completed = await persisted()
      expect(JSON.parse(completed!.snapshot_json)).toMatchObject({ active: [{ path: '' }, { path: 'completed' }] })
      expect(await second.send()).toEqual(new ClusterMachine.Accepted({}))
      const noop = await persisted()
      expect(noop!.snapshot_json).toBe(completed!.snapshot_json)
      expect(noop!.request_id).not.toBe(completed!.request_id)
    } finally {
      await second.runtime.dispose()
    }
  })

  it.each([
    ['version', 'VersionMismatch', "UPDATE cluster_machine_checkpoints SET version = 'other'"],
    ['identity', 'MachineIdMismatch', "UPDATE cluster_machine_checkpoints SET machine_id = 'other'"],
    [
      'machine state',
      'InvalidCheckpoint',
      `UPDATE cluster_machine_checkpoints SET snapshot_json = '{"_tag":"MachineSnapshot","version":2,"active":[{"path":"missing"}]}'`,
    ],
  ])('rejects incompatible %s without changing persisted state', async (_label, reason, mutation) => {
    const first = host()
    try {
      expect(await first.send()).toEqual(new ClusterMachine.Accepted({}))
    } finally {
      await first.runtime.dispose()
    }
    await database.exec(mutation)
    const before = await persisted()
    const restored = host()
    try {
      expect(await restored.send()).toMatchObject({ _tag: 'Rejected', reason })
    } finally {
      await restored.runtime.dispose()
    }
    expect(await persisted()).toEqual(before)
  })
})
