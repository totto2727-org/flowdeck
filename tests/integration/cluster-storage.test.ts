import { live } from '@effect/vitest'
import { ClusterMachine } from '@typeonce/effect-machine/cluster'
import { Effect, Exit, Fiber, Option } from 'effect'
import type { Layer } from 'effect'
import { ClusterError, Snowflake } from 'effect/cluster'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import type { D1ClusterMachineStorage } from '@/core/feature/cluster/d1-storage'
import type { D1Client } from '@/core/feature/d1/client'

import {
  address,
  checkpoint,
  laterRequest,
  makeMachineSnapshot,
  openClusterStorage,
  request,
  storageWithClient,
} from './cluster-storage.fixture.ts'

// oxlint-disable-next-line unicorn/no-null -- The snapshot fixture preserves public nullable output and state values.
const emptyJsonValue = null

const isolatedExit = Effect.fn(function* <A, E>(effect: Effect.Effect<A, E>) {
  const fiber = yield* Effect.forkScoped(effect)
  return yield* Fiber.await(fiber)
})

describe('d1 Cluster storage requirements', () => {
  test('requires only the captured D1 client', () => {
    expectTypeOf<Layer.Services<typeof D1ClusterMachineStorage>>().toEqualTypeOf<D1Client>()
  })
})

live('loads an empty address without inventing a checkpoint or receipt', () =>
  Effect.gen(function* () {
    const { freshStorage } = yield* openClusterStorage
    expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
      checkpoint: Option.none(),
      processed: false,
    })
  }).pipe(Effect.scoped),
)

live('restores the latest checkpoint and all earlier receipts from a new service without rounding snowflakes', () =>
  Effect.gen(function* () {
    const { database, freshStorage } = yield* openClusterStorage
    const storage = yield* freshStorage
    expect({
      first: yield* storage.commit(address(), checkpoint()),
      later: yield* storage.commit(address(), checkpoint(laterRequest, 'advanced')),
    }).toStrictEqual({
      first: ClusterMachine.CommitResult.Committed(),
      later: ClusterMachine.CommitResult.Committed(),
    })
    const restored = yield* freshStorage
    const latest = Option.some(checkpoint(laterRequest, 'advanced'))
    expect({
      existing: yield* restored.load(address(), request),
      neighbouring: yield* restored.load(address(), Snowflake.Snowflake('9007199254740992')),
    }).toStrictEqual({
      existing: { checkpoint: latest, processed: true },
      neighbouring: { checkpoint: latest, processed: false },
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
  }).pipe(Effect.scoped),
)

live('roundtrips every optional public snapshot field through a newly constructed storage service', () =>
  Effect.gen(function* () {
    const { freshStorage } = yield* openClusterStorage
    const value: ClusterMachine.Checkpoint = {
      ...checkpoint(),
      snapshot: makeMachineSnapshot({
        active: [{ path: '' }, { path: 'ready', value: { empty: {}, nested: [emptyJsonValue, true, 3, '日本語'] } }],
        completed: [
          { path: 'first' },
          { output: emptyJsonValue, path: 'second' },
          { output: { result: [1, 'done'] }, path: 'third' },
        ],
        history: {
          deep: {
            active: ['parent.child'],
            mode: 'deep',
            values: { 'parent.child': [false, emptyJsonValue, 'saved'] },
          },
          shallow: { active: ['ready'], mode: 'shallow', values: { ready: { draft: 'retained' } } },
        },
        version: 2,
      }),
    }
    expect(yield* (yield* freshStorage).commit(address(), value)).toStrictEqual(ClusterMachine.CommitResult.Committed())
    expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
      checkpoint: Option.some(value),
      processed: true,
    })
  }).pipe(Effect.scoped),
)

live('commits exactly once for concurrent deliveries of the same request', () =>
  Effect.gen(function* () {
    const { database, freshStorage } = yield* openClusterStorage
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
      expect(database.prepare('SELECT count(*) AS count FROM cluster_machine_requests').first()).resolves.toStrictEqual(
        {
          count: 1,
        },
      ),
    )
  }).pipe(Effect.scoped),
)

live.each([
  ['shard group', address({ group: 'other' })],
  ['shard id', address({ shard: 2 })],
  ['entity type', address({ type: 'other' })],
  ['entity id', address({ id: 'other' })],
  ['delimiter collision', address({ id: 'tail', type: 'machine:run' })],
] as const)('isolates %s in the full address', ([_label, other]) =>
  Effect.gen(function* () {
    const { freshStorage } = yield* openClusterStorage
    const first = _label === 'delimiter collision' ? address({ id: 'run:tail' }) : address()
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
  }).pipe(Effect.scoped),
)

live('rolls back the first checkpoint write when the receipt insert fails', () =>
  Effect.gen(function* () {
    const { database, freshStorage } = yield* openClusterStorage
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
  }).pipe(Effect.scoped),
)

live('preserves the earlier checkpoint and receipt when a later receipt insert aborts', () =>
  Effect.gen(function* () {
    const { database, freshStorage } = yield* openClusterStorage
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
  }).pipe(Effect.scoped),
)

live('retains native failure causes', () =>
  Effect.gen(function* () {
    const { database, freshStorage } = yield* openClusterStorage
    yield* Effect.promise(async () => database.exec('DROP TABLE cluster_machine_requests'))
    const error = yield* (yield* freshStorage).commit(address(), checkpoint()).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ClusterError.PersistenceError)
    expect(error.cause).toBeDefined()
    expect(String(error.cause)).toContain('cluster_machine_requests')
  }).pipe(Effect.scoped),
)

live('retains the exact captured client defect as the persistence cause', () =>
  Effect.gen(function* () {
    const { freshStorage, nativeClient } = yield* openClusterStorage
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve identity of the ordinary native defect injected by the D1 client.
    const cause = new Error('native batch failure')
    const storage = yield* storageWithClient({ ...(yield* nativeClient), batch: () => Effect.die(cause) })
    const error = yield* storage.commit(address(), checkpoint()).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ClusterError.PersistenceError)
    expect(error.cause).toBe(cause)
    expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
      checkpoint: Option.none(),
      processed: false,
    })
  }).pipe(Effect.scoped),
)

live('does not reclassify batch interruption as persistence failure', () =>
  Effect.gen(function* () {
    const { freshStorage, nativeClient } = yield* openClusterStorage
    const storage = yield* storageWithClient({ ...(yield* nativeClient), batch: () => Effect.interrupt })
    const commit = storage.commit(address(), checkpoint())
    const outcome = yield* isolatedExit(commit)
    expect(Exit.hasInterrupts(outcome)).toBe(true)
    expect(yield* (yield* freshStorage).load(address(), request)).toStrictEqual({
      checkpoint: Option.none(),
      processed: false,
    })
  }).pipe(Effect.scoped),
)

live.each(['{}', '{"_tag":"MachineSnapshot","version":2,"active":[{"path":42}]}'])(
  'fails safely on malformed stored snapshot %s',
  (snapshot) =>
    Effect.gen(function* () {
      const { database, freshStorage } = yield* openClusterStorage
      yield* (yield* freshStorage).commit(address(), checkpoint())
      yield* Effect.promise(async () =>
        database.prepare('UPDATE cluster_machine_checkpoints SET snapshot_json = ?').bind(snapshot).run(),
      )
      expect(yield* (yield* freshStorage).load(address(), request).pipe(Effect.flip)).toBeInstanceOf(
        ClusterError.PersistenceError,
      )
    }).pipe(Effect.scoped),
)
