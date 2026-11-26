import { ClusterMachine } from '@typeonce/effect-machine/cluster'
import { Data, Effect, Layer } from 'effect'
import { EntityAddress, EntityId, EntityType, ShardId, Snowflake } from 'effect/cluster'

import { D1ClusterMachineStorage } from '@/core/feature/cluster/d1-storage'
import { D1Client } from '@/core/feature/d1/client'

import { nativeClientLayer, openD1WorkflowTestDatabase } from './d1-workflow-database.fixture.ts'

type Address = Readonly<{ group?: string; id?: string; shard?: number; type?: string }>
export const address = ({
  group = 'group',
  id = 'run',
  shard = 1,
  type = 'machine',
}: Address = {}): EntityAddress.EntityAddress =>
  EntityAddress.make({
    entityId: EntityId.make(id),
    entityType: EntityType.make(type),
    shardId: ShardId.make(group, shard),
  })

export const request = Snowflake.Snowflake('9007199254740993')
export const laterRequest = Snowflake.Snowflake('9007199254740995')
export const machineId = 'cluster-storage-test'

type Snapshot = ClusterMachine.Checkpoint['snapshot']
type SnapshotCases = Data.TaggedEnum<{ MachineSnapshot: Omit<Snapshot, '_tag'> }>
const snapshots = Data.taggedEnum<SnapshotCases>()
export const makeMachineSnapshot = snapshots.MachineSnapshot

export const checkpoint = (requestId = request, path = 'ready'): ClusterMachine.Checkpoint => ({
  machineId,
  requestId,
  snapshot: makeMachineSnapshot({ active: [{ path }], version: 2 }),
  version: '1',
})

export const storageWithClient = (
  client: typeof D1Client.Service,
): Effect.Effect<typeof ClusterMachine.Storage.Service> => {
  const layer = D1ClusterMachineStorage.pipe(Layer.provide(Layer.succeed(D1Client, client)))
  return ClusterMachine.Storage.pipe(Effect.provide(layer))
}

export const openClusterStorage = Effect.gen(function* () {
  const { database } = yield* openD1WorkflowTestDatabase
  const layer = nativeClientLayer(database)
  const nativeClient = D1Client.pipe(Effect.provide(layer))
  const storageLayer = D1ClusterMachineStorage.pipe(Layer.provide(layer))
  return {
    database,
    freshStorage: ClusterMachine.Storage.pipe(Effect.provide(storageLayer)),
    nativeClient,
    storageLayer,
  }
})
