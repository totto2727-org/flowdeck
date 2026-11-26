import { Lifecycle } from 'agents/lifecycle'
import { DurableObjectState, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Predicate } from 'effect'

import { makeContainerHarness } from './feature/container-harness.ts'
import { decodeEnvironment } from './feature/container-host.ts'
import { containerInactivityTimeout, makeContainerLease, scheduleLease } from './feature/container-lease.ts'
import { ContainerSdkHost } from './feature/container-sdk-host.ts'
import { makeHarnessSandbox } from './feature/harness-sandbox.ts'
import { sdkWebSocketEvents } from './feature/sdk-websocket.ts'

const switchingProtocols = 101

// Construct once inside the Effect DO activation after its complete services exist.
export const makePiSdk = Effect.gen(function* () {
  const state = yield* DurableObjectState
  const env = yield* WorkerEnvironment.pipe(Effect.flatMap(decodeEnvironment), Effect.orDie)
  const lease = yield* makeContainerLease
  const host = new ContainerSdkHost(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Alchemy and the native SDK declare the same workerd state with different ambient types.
    state.raw as unknown as globalThis.DurableObjectState,
    env,
    {
      renew: lease.renew,
      start: async (currentHost) => {
        const next = await lease.renew(currentHost)
        if (Predicate.isNotNullish(next)) {
          // oxlint-disable-next-line eslint/no-use-before-define -- Lifecycle invokes this callback only after construction when it starts or resumes.
          await scheduleLease(lifecycle.jobs, next.rescheduleAt)
        }
      },
    },
  )
  const { harness, modelId } = makeContainerHarness(host, env)
  const lifecycle = new Lifecycle(host).use(harness)
  const sandbox = yield* makeHarnessSandbox({
    harness,
    initialize: (runId) => lease.initialize(lifecycle, runId),
    modelId,
  })
  return {
    fetch: (request: Request) =>
      Effect.promise(async () => {
        const response = await host.backend.handleFetch(request)
        if (response.status === switchingProtocols) {
          await host.getWorkspaceContainer().setInactivityTimeout(containerInactivityTimeout)
        }
        return response
      }),
    lifecycle,
    sandbox,
    ...sdkWebSocketEvents(lifecycle),
  }
})
