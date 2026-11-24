import { Context, Effect, HashSet, MutableRef } from 'effect'
import type { Scope } from 'effect'
import { vi } from 'vite-plus/test'

import { ExternalError } from '@/core/feature/workflow/domain/errors'

import { WorkflowCheckpoint } from './managed-runtime.ts'
import type { EventDraft } from './managed-runtime.ts'
import { ResourceStore } from './resource-store.ts'

export const runId = 'run_00000000-0000-4000-8000-000000000001'
export const unavailable = new ExternalError({ cause: 'offline', kind: 'storage', operation: 'test commit' })

class NativeResource extends Context.Service<NativeResource, Readonly<{ call: () => void }>>()('test/NativeResource') {}

type Controls = Readonly<{
  businessFailure: boolean
  finish: boolean
  invalidPhase: boolean
  multipleCheckpoints: boolean
  transportFailure: boolean
}>

const makeControls = (multipleCheckpoints: boolean): MutableRef.MutableRef<Controls> =>
  MutableRef.make<Controls>({
    businessFailure: false,
    finish: true,
    invalidPhase: false,
    multipleCheckpoints,
    transportFailure: false,
  })

const makeObservers = Effect.sync(() => ({
  external: vi.fn<(name: string) => void>(),
  resourceCalled: vi.fn<(owner: symbol) => void>(),
  resourceInitialized: vi.fn<() => symbol>(() => Symbol('native test resource')),
  resourceReleased: vi.fn<(owner: symbol) => void>(),
  resumed: vi.fn<() => void>(),
  started: vi.fn<() => void>(),
}))

type Observers = Effect.Success<typeof makeObservers>
type PhaseEffect = (
  name: string,
  drafts: Readonly<EventDraft[]>,
) => Effect.Effect<void, never, WorkflowCheckpoint | ResourceStore>

type ResourceOwner = Readonly<{ call: () => void; owner: symbol }>

const acquireResource = ({
  resourceCalled,
  resourceInitialized,
  resourceReleased,
}: Observers): Effect.Effect<ResourceOwner, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const owner = resourceInitialized()
      return {
        call: () => {
          resourceCalled(owner)
        },
        owner,
      }
    }),
    (value) =>
      Effect.sync(() => {
        resourceReleased(value.owner)
      }),
  )

const recordOnce = (
  receipts: MutableRef.MutableRef<HashSet.HashSet<string>>,
  name: string,
  external: Observers['external'],
): void => {
  const previous = MutableRef.get(receipts)
  // The test provider reconciles its own receipts. The managed runtime does not infer external idempotency.
  if (!HashSet.has(previous, name)) {
    external(name)
    MutableRef.set(receipts, HashSet.add(previous, name))
  }
}

const taskEffect = (observers: Observers): PhaseEffect => {
  const receipts = MutableRef.make(HashSet.empty<string>())
  const acquisition = acquireResource(observers)
  return (name, drafts) =>
    Effect.gen(function* () {
      const checkpoint = yield* WorkflowCheckpoint
      if (checkpoint.runId !== runId) {
        yield* Effect.die('The checkpoint belongs to a different run.')
      }
      yield* checkpoint.checkpoint(drafts)
      const resources = yield* ResourceStore
      const resource = yield* resources.getOrTryInit(NativeResource, acquisition)
      resource.call()
      recordOnce(receipts, name, observers.external)
    })
}

export const makeManagedObservers = Effect.fn('flowdeck.test.observeManagedRuntime')(function* (
  multipleCheckpoints: boolean,
) {
  const observers = yield* makeObservers
  const controlled = makeControls(multipleCheckpoints)
  const readControls = (): Controls => MutableRef.get(controlled)
  const updateControls = (change: Partial<Controls>): void => {
    MutableRef.update(controlled, (previous) => ({ ...previous, ...change }))
  }

  const check = Effect.gen(function* () {
    const checkpoint = yield* WorkflowCheckpoint
    const { finish, transportFailure } = readControls()
    if (transportFailure) {
      return yield* checkpoint.fail(unavailable)
    }
    return finish
  })
  return {
    ...observers,
    check,
    effect: taskEffect(observers),
    readControls,
    setBusinessFailure: () => {
      updateControls({ businessFailure: true })
    },
    setFinish: (finish: boolean) => {
      updateControls({ finish })
    },
    setInvalidPhase: () => {
      updateControls({ invalidPhase: true })
    },
    setTransportFailure: () => {
      updateControls({ transportFailure: true })
    },
  }
})
