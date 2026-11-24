import { getWorkspace, withWorkspace } from '@cloudflare/computer'
import type { WorkspaceOptions } from '@cloudflare/computer'
import { ContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { PiHarness } from 'agents/harness/pi'
import { Lifecycle } from 'agents/lifecycle'
import type { LifecycleJobContext, LifecycleJobOutcome } from 'agents/lifecycle'
import { DurableObjectState, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { DurableObject } from 'cloudflare:workers'
import { Clock, Effect, Predicate, Schema } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { RunId } from '@/core/feature/workflow/domain/identity'
import { Store } from '@/core/feature/workflow/services/store'

import { makeHarnessSandbox } from './feature/harness-sandbox.ts'
import { makePiModels } from './feature/models.ts'
import { sdkWebSocketEvents } from './feature/sdk-websocket.ts'
import { CONTAINER_BACKEND, createWorkspaceTools } from './feature/workspace.ts'

const Environment = Schema.Struct({
  CLOUDFLARE_ACCOUNT_ID: Schema.String,
  CLOUDFLARE_AI_GATEWAY_ID: Schema.String,
  CLOUDFLARE_AI_GATEWAY_API_KEY: Schema.String,
})
const decodeEnvironment = Schema.decodeUnknownEffect(Environment)
const decodeRunId = Schema.decodeUnknownEffect(RunId)
const LEASE_JOB = 'workspace-lease'
const RENEW_AFTER_MS = 5 * 60 * 60 * 1000
const INACTIVITY_MS = 6 * 60 * 60 * 1000

class ContainerHost extends withWorkspaceContainer(class extends DurableObject<typeof Environment.Type> {}) {
  readonly backend = new ContainerBackend({
    container: () => this,
    workspace: { binding: 'DevelopmentRun', id: this.ctx.id.toString() },
    egress: { mode: 'direct' },
    id: CONTAINER_BACKEND,
    name: 'JcodeSandbox',
    instance: 'standard-1',
  })

  workspaceOptions(): WorkspaceOptions {
    return { storage: this.ctx.storage, backends: [this.backend] }
  }
}

/** Only the official SDK host is native, never the deployed Worker or Durable Object. */
class SdkHost extends withWorkspace(ContainerHost, (host) => host.workspaceOptions()) {
  readonly renew: () => Promise<LifecycleJobOutcome>
  readonly start: () => Promise<void>

  constructor(
    state: globalThis.DurableObjectState,
    env: typeof Environment.Type,
    renew: () => Promise<LifecycleJobOutcome>,
    start: () => Promise<void>,
  ) {
    super(state, env)
    this.renew = renew
    this.start = start
  }

  onStart(): Promise<void> {
    return this.start()
  }

  onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return job.fn === LEASE_JOB ? this.renew() : Promise.resolve(undefined)
  }
}

/** Construct once inside the Effect DO activation, after its complete services exist. */
export const makePiSdk = Effect.gen(function* () {
  const state = yield* DurableObjectState
  const store = yield* Store
  const env = yield* WorkerEnvironment.pipe(Effect.flatMap(decodeEnvironment), Effect.orDie)
  const context = yield* Effect.context<DurableObjectState | import('alchemy/RuntimeContext').RuntimeContext>()

  /*
   * Lifecycle's public constructor requires an actual native DurableObject host, and
   * withWorkspaceContainer reads that host's native ctx. Alchemy deliberately exposes
   * state.raw, not its generated host instance. Instantiate the official SDK mixins
   * with that exact state here only. The deployed DO remains Alchemy's Effect bridge,
   * application storage uses its Effect adapter, and no fake host or runtime is made.
   * SDK callbacks re-enter this captured activation context because the native SDK
   * invokes Promise callbacks outside Effect. No Layer is rebuilt per callback.
   * Alchemy names its native types through @cloudflare/workers-types, while these
   * SDKs use ambient Worker types mixed with the frontend DOM declarations. They
   * describe the same workerd objects but disagree structurally on Request and
   * WebSocket. Keep those declaration-only conversions at this SDK boundary.
   */
  const host: SdkHost = new SdkHost(
    state.raw as unknown as ConstructorParameters<typeof DurableObject>[0],
    env,
    () =>
      // oxlint-disable-next-line rules/no-effect-runtime-run -- The native SDK calls Promise callbacks with no Effect runtime and reuses the captured activation context.
      Effect.runPromise(
        Effect.gen(function* () {
          const active = yield* state.storage.get('active-run-id')
          if (Predicate.isUndefined(active)) {
            return undefined
          }
          const runId = yield* decodeRunId(active)
          const run = yield* store.getRun(runId)
          const container = host.getWorkspaceContainer()
          if (run.status === 'completed' || !(yield* Effect.promise(() => container.status())).running) {
            return undefined
          }
          yield* Effect.promise(() => container.setInactivityTimeout(INACTIVITY_MS))
          return { rescheduleAt: (yield* Clock.currentTimeMillis) + RENEW_AFTER_MS }
        }).pipe(Effect.provideContext(context)),
      ),
    async () => {
      const next = await host.renew()
      if (Predicate.isObject(next)) {
        await lifecycle.jobs.push({ id: LEASE_JOB, fn: LEASE_JOB, time: next.rescheduleAt })
      }
    },
  )
  const { models, model } = makePiModels({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
    apiKey: env.CLOUDFLARE_AI_GATEWAY_API_KEY,
  })
  const harness = new PiHarness({
    defaults: { model },
    harness: async ({ storage, context }) => {
      /*
       * This must remain isolate-local. WorkspaceStub extends capnweb.RpcTarget,
       * not Cloudflare's RpcTarget, and native service bindings cannot clone it.
       * Only start/resume's JSON wire contract is exported by the outer Effect DO.
       */
      const workspace = await getWorkspace(host)
      const registry = createRegistry()
      registry.install({ name: 'workspace', tools: createWorkspaceTools(workspace) })
      return Harness.open(storage, { models, registry }, context)
    },
  })
  const lifecycle = new Lifecycle(host).use(harness)
  const io = <A>(evaluate: () => Promise<A>): Effect.Effect<A, ExternalError> =>
    Effect.tryPromise({
      catch: (cause) => new ExternalError({ operation: 'access Pi sandbox', cause, kind: 'service' }),
      try: evaluate,
    })
  const sandbox = yield* makeHarnessSandbox({
    harness,
    modelId: model.id,
    initialize: (runId) =>
      Effect.gen(function* () {
        /*
         * The machine-owned Pi node acquires its resource here. Activation only
         * installs SDK descriptors, and cannot start a run or its workspace.
         */
        yield* io(() => lifecycle.start())
        yield* state.storage.put('active-run-id', runId)
        const renewAt = (yield* Clock.currentTimeMillis) + RENEW_AFTER_MS
        yield* io(() => lifecycle.jobs.push({ id: LEASE_JOB, fn: LEASE_JOB, time: renewAt }))
      }),
  })
  return {
    sandbox,
    fetch: (request: Request) =>
      Effect.promise(async () => {
        const response = await host.backend.handleFetch(request)
        if (response.status === 101) {
          await host.getWorkspaceContainer().setInactivityTimeout(INACTIVITY_MS)
        }
        return response
      }),
    lifecycle,
    ...sdkWebSocketEvents(lifecycle),
  }
})
