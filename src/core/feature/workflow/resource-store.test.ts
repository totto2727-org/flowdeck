import { Array, Context, Deferred, Effect, Fiber, Option, Ref } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { ResourceStore } from './resource-store'

class NativeResource extends Context.Service<NativeResource, { readonly read: () => string }>()(
  'test/NativeResource',
) {}
class OtherResource extends Context.Service<OtherResource, { readonly read: () => string }>()('test/OtherResource') {}
class Configuration extends Context.Service<Configuration, { readonly name: string }>()('test/ResourceConfiguration') {}

const resource = { read: () => 'native reference' }

const run = <A, E>(effect: Effect.Effect<A, E, import('effect/Scope').Scope>) =>
  Effect.runPromise(Effect.scoped(effect))

describe('ResourceStore', () => {
  it('is lazy and retains native references without serializing them', async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ResourceStore.make
        const calls = yield* Ref.make(0)
        const initialize = Ref.update(calls, (count) => count + 1).pipe(Effect.as(resource))
        const pending = store.getOrTryInit(NativeResource, initialize)
        expect(yield* store.get(NativeResource)).toEqual(Option.none())
        expect(yield* Ref.get(calls)).toBe(0)
        expect(yield* pending).toBe(resource)
        expect(yield* store.getOrTryInit(NativeResource, Effect.die('must not initialize twice'))).toBe(resource)
        expect(yield* store.get(NativeResource)).toEqual(Option.some(resource))
        expect(yield* Ref.get(calls)).toBe(1)
      }),
    )
  })

  it('shares one successful initializer among concurrent callers for the same key', async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ResourceStore.make
        const calls = yield* Ref.make(0)
        const initialize = Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.as(resource),
        )
        const results = yield* Effect.all(
          Array.makeBy(8, () => store.getOrTryInit(NativeResource, initialize)),
          { concurrency: 'unbounded' },
        )
        expect(results).toHaveLength(8)
        Array.forEach(results, (value) => expect(value).toBe(resource))
        expect(yield* Ref.get(calls)).toBe(1)
      }),
    )
  })

  it('allows different keys to initialize concurrently', async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ResourceStore.make
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const first = Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(secondStarted)),
          Effect.as(resource),
        )
        const other = { read: () => 'other' }
        const second = Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(Deferred.await(firstStarted)),
          Effect.as(other),
        )
        const results = yield* Effect.all(
          [store.getOrTryInit(NativeResource, first), store.getOrTryInit(OtherResource, second)],
          { concurrency: 'unbounded' },
        ).pipe(Effect.timeout('2 seconds'))
        expect(results[0]).toBe(resource)
        expect(results[1]).toBe(other)
      }),
    )
  })

  it('does not cache failures and allows a later initializer to succeed', async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ResourceStore.make
        expect(yield* store.getOrTryInit(NativeResource, Effect.fail('unavailable')).pipe(Effect.flip)).toBe(
          'unavailable',
        )
        expect(yield* store.get(NativeResource)).toEqual(Option.none())
        expect(yield* store.getOrTryInit(NativeResource, Effect.succeed(resource))).toBe(resource)
      }),
    )
  })

  it('releases a key after its initializing caller is interrupted', async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ResourceStore.make
        const started = yield* Deferred.make<void>()
        const initializer = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        const fiber = yield* store.getOrTryInit(NativeResource, initializer).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(yield* store.get(NativeResource)).toEqual(Option.none())
        expect(yield* store.getOrTryInit(NativeResource, Effect.succeed(resource))).toBe(resource)
      }),
    )
  })

  it('releases a failed attempt before retry and retains the successful resource until runtime closure', async () => {
    const releases = await Effect.runPromise(
      Effect.gen(function* () {
        const finalized = yield* Ref.make<ReadonlyArray<string>>([])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* ResourceStore.make
            const acquire = (name: string) =>
              Effect.acquireRelease(Effect.succeed({ read: () => name }), () =>
                Ref.update(finalized, Array.append(name)),
              )
            const failed = acquire('failed').pipe(Effect.andThen(Effect.fail('unavailable')))
            expect(yield* store.getOrTryInit(NativeResource, failed).pipe(Effect.flip)).toBe('unavailable')
            expect(yield* Ref.get(finalized)).toEqual(['failed'])
            expect(yield* store.get(NativeResource)).toEqual(Option.none())
            const successful = yield* store.getOrTryInit(NativeResource, acquire('successful'))
            expect(successful.read()).toBe('successful')
            expect(yield* Ref.get(finalized)).toEqual(['failed'])
          }),
        )
        return yield* Ref.get(finalized)
      }),
    )
    expect(releases).toEqual(['failed', 'successful'])
  })

  it('releases an interrupted attempt before retry and retains the successful resource until runtime closure', async () => {
    const releases = await Effect.runPromise(
      Effect.gen(function* () {
        const finalized = yield* Ref.make<ReadonlyArray<string>>([])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* ResourceStore.make
            const started = yield* Deferred.make<void>()
            const acquire = (name: string) =>
              Effect.acquireRelease(Effect.succeed({ read: () => name }), () =>
                Ref.update(finalized, Array.append(name)),
              )
            const interrupted = acquire('interrupted').pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
            )
            const fiber = yield* store.getOrTryInit(NativeResource, interrupted).pipe(Effect.forkScoped)
            yield* Deferred.await(started)
            yield* Fiber.interrupt(fiber)
            expect(yield* Ref.get(finalized)).toEqual(['interrupted'])
            expect(yield* store.get(NativeResource)).toEqual(Option.none())
            const successful = yield* store.getOrTryInit(NativeResource, acquire('successful'))
            expect(successful.read()).toBe('successful')
            expect(yield* Ref.get(finalized)).toEqual(['interrupted'])
          }),
        )
        return yield* Ref.get(finalized)
      }),
    )
    expect(releases).toEqual(['interrupted', 'successful'])
  })

  it('keeps resource finalizers alive until the owning runtime closes', async () => {
    const releases = await Effect.runPromise(
      Effect.gen(function* () {
        const finalized = yield* Ref.make(0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* ResourceStore.make
            const initialize = Effect.acquireRelease(Effect.succeed(resource), () =>
              Ref.update(finalized, (count) => count + 1),
            )
            yield* Effect.scoped(store.getOrTryInit(NativeResource, initialize))
            expect(yield* Ref.get(finalized)).toBe(0)
            expect(yield* store.getOrTryInit(NativeResource, initialize)).toBe(resource)
          }),
        )
        return yield* Ref.get(finalized)
      }),
    )
    expect(releases).toBe(1)
  })

  it('isolates resources between fresh runtime stores', async () => {
    await run(
      Effect.gen(function* () {
        const first = yield* ResourceStore.make
        yield* first.getOrTryInit(NativeResource, Effect.succeed(resource))
        const second = yield* ResourceStore.make
        expect(yield* second.get(NativeResource)).toEqual(Option.none())
        const replacement = { read: () => 'replacement' }
        expect(yield* second.getOrTryInit(NativeResource, Effect.succeed(replacement))).toBe(replacement)
        expect(yield* first.getOrTryInit(NativeResource, Effect.succeed(replacement))).toBe(resource)
      }),
    )
  })

  it('retains typed initializer dependencies through its service Layer', async () => {
    const program = Effect.gen(function* () {
      const store = yield* ResourceStore
      const initialize = Effect.map(Configuration, ({ name }) => ({ read: () => name }))
      const initialized = store.getOrTryInit(NativeResource, initialize)
      expectTypeOf(initialized).toEqualTypeOf<Effect.Effect<{ readonly read: () => string }, never, Configuration>>()
      expectTypeOf(store.get(NativeResource)).toEqualTypeOf<
        Effect.Effect<Option.Option<{ readonly read: () => string }>>
      >()
      return (yield* initialized).read()
    }).pipe(Effect.provide(ResourceStore.layer), Effect.provideService(Configuration, { name: 'configured' }))
    expect(await Effect.runPromise(program)).toBe('configured')
  })
})
