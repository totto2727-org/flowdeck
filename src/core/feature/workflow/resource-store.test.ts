import { live } from '@effect/vitest'
import { Array, Context, Deferred, Effect, Fiber, Option, Ref } from 'effect'
import type { Scope } from 'effect'
import { describe, expect, expectTypeOf } from 'vite-plus/test'

import { ResourceStore } from './resource-store.ts'

type Resource = Readonly<{ read: () => string }>
const NativeResource = Context.Service<Resource>('test/NativeResource')
const OtherResource = Context.Service<Resource>('test/OtherResource')
class Configuration extends Context.Service<Configuration, Readonly<{ name: string }>>()(
  'test/ResourceConfiguration',
) {}

const resource: Resource = { read: () => 'native reference' }
const other: Resource = { read: () => 'other' }
const initialCount = 0
const nextCount = 1
const parallelCallers = 8

describe('resource store initialization', () => {
  live('is lazy and retains native references without serializing them', () =>
    Effect.gen(function* () {
      const store = yield* ResourceStore.make
      const calls = yield* Ref.make(initialCount)
      const initialize = Ref.update(calls, (count) => count + nextCount).pipe(Effect.as(resource))
      const pending = store.getOrTryInit(NativeResource, initialize)
      expect({ calls: yield* Ref.get(calls), existing: yield* store.get(NativeResource) }).toStrictEqual({
        calls: initialCount,
        existing: Option.none(),
      })
      expect(yield* pending).toBe(resource)
      expect(yield* store.getOrTryInit(NativeResource, Effect.die('must not initialize twice'))).toBe(resource)
      expect({ calls: yield* Ref.get(calls), existing: yield* store.get(NativeResource) }).toStrictEqual({
        calls: nextCount,
        existing: Option.some(resource),
      })
    }).pipe(Effect.scoped),
  )

  live('shares one successful initializer among concurrent callers for the same key', () =>
    Effect.gen(function* () {
      const store = yield* ResourceStore.make
      const calls = yield* Ref.make(initialCount)
      const initialize = Ref.update(calls, (count) => count + nextCount).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.as(resource),
      )
      const pending = Array.makeBy(parallelCallers, () => store.getOrTryInit(NativeResource, initialize))
      const results = yield* Effect.all(pending, { concurrency: 'unbounded' })
      expect(results).toHaveLength(parallelCallers)
      expect(Array.every(results, (result) => result === resource)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(nextCount)
    }).pipe(Effect.scoped),
  )
})

describe('resource store ownership and independence', () => {
  live('allows different keys to initialize concurrently', () =>
    Effect.gen(function* () {
      const store = yield* ResourceStore.make
      const firstStarted = yield* Deferred.make<boolean>()
      const secondStarted = yield* Deferred.make<boolean>()
      const first = Deferred.succeed(firstStarted, true).pipe(
        Effect.andThen(Deferred.await(secondStarted)),
        Effect.as(resource),
      )
      const second = Deferred.succeed(secondStarted, true).pipe(
        Effect.andThen(Deferred.await(firstStarted)),
        Effect.as(other),
      )
      const results = yield* Effect.all(
        [store.getOrTryInit(NativeResource, first), store.getOrTryInit(OtherResource, second)],
        { concurrency: 'unbounded' },
      ).pipe(Effect.timeout('2 seconds'))
      expect(results[0]).toBe(resource)
      expect(results[1]).toBe(other)
    }).pipe(Effect.scoped),
  )

  live('isolates native references between fresh runtime stores', () =>
    Effect.gen(function* () {
      const first = yield* ResourceStore.make
      yield* first.getOrTryInit(NativeResource, Effect.succeed(resource))
      const second = yield* ResourceStore.make
      expect(yield* second.get(NativeResource)).toStrictEqual(Option.none())
      const replacement = { read: () => 'replacement' }
      expect(yield* second.getOrTryInit(NativeResource, Effect.succeed(replacement))).toBe(replacement)
      expect(yield* first.getOrTryInit(NativeResource, Effect.succeed(replacement))).toBe(resource)
    }).pipe(Effect.scoped),
  )
})

const stopInitialization = Effect.fn('flowdeck.test.interruptResourceInitialization')(function* (
  store: Effect.Success<typeof ResourceStore.make>,
  acquire: Effect.Effect<unknown, never, Scope.Scope> = Effect.void,
) {
  const started = yield* Deferred.make<boolean>()
  const initializer = acquire.pipe(Effect.andThen(Deferred.succeed(started, true)), Effect.andThen(Effect.never))
  const fiber = yield* store.getOrTryInit(NativeResource, initializer).pipe(Effect.forkScoped)
  yield* Deferred.await(started)
  yield* Fiber.interrupt(fiber)
})

describe('resource store retry', () => {
  live('does not cache failures and allows a later initializer to succeed', () =>
    Effect.gen(function* () {
      const store = yield* ResourceStore.make
      const failed = store.getOrTryInit(NativeResource, Effect.fail('unavailable'))
      expect(yield* failed.pipe(Effect.flip)).toBe('unavailable')
      expect(yield* store.get(NativeResource)).toStrictEqual(Option.none())
      expect(yield* store.getOrTryInit(NativeResource, Effect.succeed(resource))).toBe(resource)
    }).pipe(Effect.scoped),
  )

  live('releases a key after its initializing caller is interrupted', () =>
    Effect.gen(function* () {
      const store = yield* ResourceStore.make
      yield* stopInitialization(store)
      expect(yield* store.get(NativeResource)).toStrictEqual(Option.none())
      expect(yield* store.getOrTryInit(NativeResource, Effect.succeed(resource))).toBe(resource)
    }).pipe(Effect.scoped),
  )
})

const acquireRecorded = (
  finalized: Ref.Ref<Readonly<string[]>>,
  name: string,
): Effect.Effect<Resource, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.succeed({ read: () => name }), () => Ref.update(finalized, Array.append(name)))

const openResourceLifetime = Effect.fn('flowdeck.test.openResourceLifetime')(function* (
  finalized: Ref.Ref<Readonly<string[]>>,
) {
  const store = yield* ResourceStore.make
  return {
    acquire: (name: string): Effect.Effect<Resource, never, Scope.Scope> => acquireRecorded(finalized, name),
    store,
  }
})

type OwnedResource = Effect.Success<ReturnType<typeof openResourceLifetime>>

const observeRetry = Effect.fn('flowdeck.test.observeResourceRetry')(function* (
  { acquire, store }: OwnedResource,
  finalized: Ref.Ref<Readonly<string[]>>,
) {
  const before = yield* Ref.get(finalized)
  const cached = yield* store.get(NativeResource)
  const successful = yield* store.getOrTryInit(NativeResource, acquire('successful'))
  return { before, cached, finalizers: yield* Ref.get(finalized), value: successful.read() }
})

describe('resource store finalizers for failed or interrupted attempts', () => {
  live('releases a failed attempt before retry and retains the new resource until closure', () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make<Readonly<string[]>>([])
      yield* Effect.gen(function* () {
        const owned = yield* openResourceLifetime(finalized)
        const failed = owned.acquire('failed').pipe(Effect.andThen(Effect.fail('unavailable')))
        const attempt = owned.store.getOrTryInit(NativeResource, failed)
        expect(yield* attempt.pipe(Effect.flip)).toBe('unavailable')
        expect(yield* observeRetry(owned, finalized)).toStrictEqual({
          before: ['failed'],
          cached: Option.none(),
          finalizers: ['failed'],
          value: 'successful',
        })
      }).pipe(Effect.scoped)
      expect(yield* Ref.get(finalized)).toStrictEqual(['failed', 'successful'])
    }),
  )

  live('releases an interrupted attempt before retry and retains the new resource until closure', () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make<Readonly<string[]>>([])
      yield* Effect.gen(function* () {
        const owned = yield* openResourceLifetime(finalized)
        yield* stopInitialization(owned.store, owned.acquire('interrupted'))
        expect(yield* observeRetry(owned, finalized)).toStrictEqual({
          before: ['interrupted'],
          cached: Option.none(),
          finalizers: ['interrupted'],
          value: 'successful',
        })
      }).pipe(Effect.scoped)
      expect(yield* Ref.get(finalized)).toStrictEqual(['interrupted', 'successful'])
    }),
  )
})

describe('resource store runtime scope', () => {
  live('keeps successful resource finalizers alive until the owning runtime closes', () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make(initialCount)
      yield* Effect.gen(function* () {
        const store = yield* ResourceStore.make
        const initialize = Effect.acquireRelease(Effect.succeed(resource), () =>
          Ref.update(finalized, (count) => count + nextCount),
        )
        yield* Effect.scoped(store.getOrTryInit(NativeResource, initialize))
        expect(yield* Ref.get(finalized)).toBe(initialCount)
        expect(yield* store.getOrTryInit(NativeResource, initialize)).toBe(resource)
      }).pipe(Effect.scoped)
      expect(yield* Ref.get(finalized)).toBe(nextCount)
    }),
  )

  live('retains typed initializer dependencies through its service Layer', () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const store = yield* ResourceStore
        const initialize = Effect.map(Configuration, ({ name }) => ({ read: () => name }))
        const initialized = store.getOrTryInit(NativeResource, initialize)
        expectTypeOf(initialized).toEqualTypeOf<Effect.Effect<Resource, never, Configuration>>()
        expectTypeOf(store.get(NativeResource)).toEqualTypeOf<Effect.Effect<Option.Option<Resource>>>()
        return (yield* initialized).read()
      }).pipe(Effect.provide(ResourceStore.layer), Effect.provideService(Configuration, { name: 'configured' }))
      expect(yield* program).toBe('configured')
    }),
  )
})
