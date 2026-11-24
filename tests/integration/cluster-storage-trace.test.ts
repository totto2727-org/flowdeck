import { live } from '@effect/vitest'
import { ClusterMachine } from '@typeonce/effect-machine/cluster'
import { Array, Effect, Option } from 'effect'
import { expect, vi } from 'vite-plus/test'

import type { D1Client } from '@/core/feature/d1/client'

import { address, checkpoint, openClusterStorage, request, storageWithClient } from './cluster-storage.fixture.ts'

type Counts = Readonly<{ batches: number[]; prepares: number; reads: number }>
type Trace = Readonly<{
  counts: () => Counts
  resetPrepareAndBatch: () => void
  restore: () => void
}>

const instrumentClient = (client: typeof D1Client.Service): Effect.Effect<Trace> =>
  Effect.sync(() => {
    const nativePrepare = client.prepare.bind(client)
    const read = vi.fn<() => void>()
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
    return {
      counts: (): Counts => ({
        batches: Array.map(batch.mock.calls, ([commands]) => Array.length(commands)),
        prepares: Array.length(prepare.mock.calls),
        reads: Array.length(read.mock.calls),
      }),
      resetPrepareAndBatch: (): void => {
        prepare.mockClear()
        batch.mockClear()
      },
      restore: (): void => {
        prepare.mockRestore()
        batch.mockRestore()
      },
    }
  })

const observeNativeStorage = Effect.gen(function* () {
  const { nativeClient } = yield* openClusterStorage
  const client = yield* nativeClient
  const trace = yield* Effect.acquireRelease(instrumentClient(client), (observer) => Effect.sync(observer.restore))
  const storage = yield* storageWithClient(client)
  return { storage, trace }
})

live('commits with two native prepares and one batch without reads, then loads with one read', () =>
  Effect.gen(function* () {
    const { storage, trace } = yield* observeNativeStorage
    expect(yield* storage.commit(address(), checkpoint())).toStrictEqual(ClusterMachine.CommitResult.Committed())
    expect(trace.counts()).toStrictEqual({ batches: [2], prepares: 2, reads: 0 })
    trace.resetPrepareAndBatch()
    expect(yield* storage.load(address(), request)).toStrictEqual({
      checkpoint: Option.some(checkpoint()),
      processed: true,
    })
    expect(trace.counts()).toStrictEqual({ batches: [], prepares: 1, reads: 1 })
  }).pipe(Effect.scoped),
)
