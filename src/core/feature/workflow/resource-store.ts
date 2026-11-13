import { Context, Effect, Exit, Layer, MutableHashMap, Option, Scope, Semaphore } from 'effect'

export interface ResourceStoreService {
  readonly get: <I, A>(key: Context.Key<I, A>) => Effect.Effect<Option.Option<A>>
  readonly getOrTryInit: <I, A, E, R>(
    key: Context.Key<I, A>,
    initialize: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Scope.Scope>>
}

/** Runtime-local resources, including native references and functions, never enter persisted snapshots. */
export class ResourceStore extends Context.Service<ResourceStore, ResourceStoreService>()('flowdeck/ResourceStore') {
  static readonly make = Effect.gen(function* () {
    const scope = yield* Effect.scope
    let resources: Context.Context<never> = Context.empty()
    const locks = MutableHashMap.empty<string, Semaphore.Semaphore>()

    const get = <I, A>(key: Context.Key<I, A>) => Effect.sync(() => Context.getOption(resources, key))

    const getOrTryInit = <I, A, E, R>(key: Context.Key<I, A>, initialize: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        // Allocate the per-key lock synchronously before any initializer can suspend.
        const lock = Option.getOrElse(MutableHashMap.get(locks, key.key), () => {
          const created = Semaphore.makeUnsafe(1)
          MutableHashMap.set(locks, key.key, created)
          return created
        })
        return lock.withPermit(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const existing = yield* get(key)
              if (Option.isSome(existing)) return existing.value
              // Each attempt needs cleanup on failure; successful children stay attached to the runtime scope.
              // Provide this scope here because a caller's operation scope must not own cached resources.
              const attempt = yield* Scope.fork(scope)
              const resource = yield* restore(Scope.provide(attempt)(initialize)).pipe(
                Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(attempt, exit) : Effect.void)),
              )
              resources = Context.add(resources, key, resource)
              return resource
            }),
          ),
        )
      })

    return ResourceStore.of({ get, getOrTryInit })
  })

  static readonly layer = Layer.effect(ResourceStore, ResourceStore.make)
}
