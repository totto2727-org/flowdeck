import { BrowserCrypto } from '@effect/platform-browser'
import { Effect } from 'effect'

import { LifecycleHook } from './lifecycle.ts'
import { prepareManagedProgram } from './managed-runtime-machine.fixture.ts'
import { makeManagedObservers } from './managed-runtime-observers.fixture.ts'
import { graph, makeManagedPersistence, version, workflowId } from './managed-runtime-persistence.fixture.ts'
import { makeManagedExecutor, restoreManagedSnapshot } from './managed-runtime.ts'
import { Store } from './services/store.ts'

const noObserver = { afterCommit: () => Effect.void }

export const makeHarness = Effect.fn('flowdeck.test.openManagedRuntime')(function* (multipleCheckpoints?: boolean) {
  const observers = yield* makeManagedObservers(multipleCheckpoints ?? false)
  const { machine, program } = yield* prepareManagedProgram(observers)
  const persistence = makeManagedPersistence(machine)
  const definition = { graph, program: Effect.succeed(program), version, workflowId }
  const executor = Effect.fn('flowdeck.test.openManagedExecutor')(function* (
    afterCommit: typeof LifecycleHook.Service = noObserver,
  ) {
    return yield* makeManagedExecutor(definition).pipe(
      Effect.provideService(Store, persistence.store),
      Effect.provideService(LifecycleHook, afterCommit),
      Effect.provide(BrowserCrypto.layer),
    )
  })

  return {
    ...observers,
    ...persistence,
    executor,
    restore: () =>
      restoreManagedSnapshot({ ...definition, decode: program.decode, status: program.status }, persistence.current()),
  }
})
