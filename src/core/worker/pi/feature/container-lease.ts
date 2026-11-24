import type { Lifecycle } from 'agents/lifecycle'
import { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Clock, Duration, Effect, Option, Predicate, Schema } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { RunId } from '@/core/feature/workflow/domain/identity'
import { Store } from '@/core/feature/workflow/services/store'

import type { ContainerHost } from './container-host.ts'

export const leaseJob = 'workspace-lease'
const activeRunKey = 'active-run-id'
const renewAfter = Duration.toMillis('5 hours')
export const containerInactivityTimeout = Duration.toMillis('6 hours')
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The active run ID is an unknown value loaded from durable storage.
const decodeRunId = Schema.decodeUnknownEffect(RunId)

const leaseTime = Effect.map(Clock.currentTimeMillis, (now) => now + renewAfter)
type LeaseJobs = Pick<Lifecycle['jobs'], 'push'>

export const scheduleLease = async (jobs: LeaseJobs, time: number): Promise<void> => {
  await jobs.push({ fn: leaseJob, id: leaseJob, time })
}

const sandboxIO = <A>(evaluate: () => Promise<A>): Effect.Effect<A, ExternalError> =>
  Effect.tryPromise({
    catch: (cause) => new ExternalError({ cause, kind: 'service', operation: 'access Pi sandbox' }),
    try: evaluate,
  })

export const makeContainerLease = Effect.gen(function* () {
  const state = yield* DurableObjectState
  const store = yield* Store
  const context = yield* Effect.context<DurableObjectState | RuntimeContext>()

  const renew = Effect.fn('flowdeck.renewContainerLease')(function* (host: ContainerHost) {
    const active = yield* state.storage.get(activeRunKey)
    // oxlint-disable-next-line rules/prefer-is-nullish -- Storage uses undefined for a missing run. A stored null must still fail validation.
    if (Predicate.isUndefined(active)) {
      return Option.none()
    }
    const runId = yield* decodeRunId(active)
    const run = yield* store.getRun(runId)
    const container = host.getWorkspaceContainer()
    if (run.status === 'completed' || !(yield* Effect.promise(async () => container.status())).running) {
      return Option.none()
    }
    yield* Effect.promise(async () => container.setInactivityTimeout(containerInactivityTimeout))
    return Option.some({ rescheduleAt: yield* leaseTime })
  })

  const initialize = Effect.fn('flowdeck.initializeContainerLease')(function* (
    lifecycle: Pick<Lifecycle, 'jobs' | 'start'>,
    runId: RunId,
  ) {
    // Acquiring the Pi node starts the resource. Activation only installs SDK descriptors.
    yield* sandboxIO(async () => lifecycle.start())
    yield* state.storage.put(activeRunKey, runId)
    const renewAt = yield* leaseTime
    yield* sandboxIO(async () => scheduleLease(lifecycle.jobs, renewAt))
  })

  return {
    initialize,
    renew: async (host: ContainerHost) => {
      const renewal = renew(host).pipe(Effect.provideContext(context), Effect.map(Option.getOrUndefined))
      // oxlint-disable-next-line rules/no-effect-runtime-run -- Native SDK callbacks reuse the existing activation context when called from outside Effect.
      return Effect.runPromise(renewal)
    },
  }
})
