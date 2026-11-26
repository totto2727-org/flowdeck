import { Context, Effect, Exit, Layer, MutableHashMap, Option, Ref, Scope, Semaphore } from 'effect'

export type ResourceStoreService = Readonly<{
  get: <I, A>(key: Context.Key<I, A>) => Effect.Effect<Option.Option<A>>
  getOrTryInit: <I, A, E, R>(
    key: Context.Key<I, A>,
    initialize: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Scope.Scope>>
}>

/** Runtime-local resources, including native references and functions, never enter persisted snapshots. */
export class ResourceStore extends Context.Service<ResourceStore, ResourceStoreService>()('flowdeck/ResourceStore') {
  // oxlint-disable-next-line rules/no-readonly -- The public construction effect is fixed for this service class.
  public static readonly make = Effect.gen(function* () {
    const scope = yield* Effect.scope
    const resources = yield* Ref.make<Context.Context<never>>(Context.empty())
    const locks = MutableHashMap.empty<string, Semaphore.Semaphore>()
    const exclusivePermit = 1

    const get = <I, A>(key: Context.Key<I, A>): Effect.Effect<Option.Option<A>> =>
      Ref.get(resources).pipe(Effect.map((context) => Context.getOption(context, key)))

    const getOrTryInit = <I, A, E, R>(
      key: Context.Key<I, A>,
      initialize: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
      Effect.suspend(() => {
        // Allocate the per-key lock synchronously before any initializer can suspend.
        const lock = Option.getOrElse(MutableHashMap.get(locks, key.key), () => {
          const created = Semaphore.makeUnsafe(exclusivePermit)
          MutableHashMap.set(locks, key.key, created)
          return created
        })
        return lock.withPermit(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const existing = yield* get(key)
              if (Option.isSome(existing)) {
                return existing.value
              }
              // Each attempt needs cleanup on failure; successful children stay attached to the runtime scope.
              // Provide this scope here because a caller's operation scope must not own cached resources.
              const attempt = yield* Scope.fork(scope)
              const resource = yield* restore(Scope.provide(attempt)(initialize)).pipe(
                Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(attempt, exit) : Effect.void)),
              )
              yield* Ref.update(resources, (context) => Context.add(context, key, resource))
              return resource
            }),
          ),
        )
      })

    return ResourceStore.of({ get, getOrTryInit })
  })

  // oxlint-disable-next-line rules/no-readonly -- The public layer always owns the resources and their native scope.
  public static readonly layer = Layer.effect(ResourceStore, ResourceStore.make)
}
