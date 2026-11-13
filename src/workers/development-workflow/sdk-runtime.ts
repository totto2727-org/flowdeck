import { getWorkspace, withWorkspace, type WorkspaceOptions } from '@cloudflare/computer'
import { ContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container'
import type { WebSocket as WorkerWebSocket } from '@cloudflare/workers-types'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { PiHarness, ROOT_SESSION } from 'agents/harness/pi'
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle'
import { DurableObjectState, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { DurableObject } from 'cloudflare:workers'
import { Array, Clock, Effect, Schema, Semaphore } from 'effect'

import { ExternalError } from '@/features/workflow/domain/errors'
import { RunId } from '@/features/workflow/domain/identity'
import { Store } from '@/features/workflow/services/store'

import { CommandId, SessionId, type Session, type TurnReceipt } from './features/model'
import { makeDevelopmentModels } from './features/models'
import { DevelopmentSandbox } from './features/sandbox'
import { CONTAINER_BACKEND, createWorkspaceTools } from './features/workspace'

const Environment = Schema.Struct({
  CLOUDFLARE_ACCOUNT_ID: Schema.String,
  CLOUDFLARE_AI_GATEWAY_ID: Schema.String,
  CLOUDFLARE_AI_GATEWAY_API_KEY: Schema.String,
})
const decodeSessionId = Schema.decodeUnknownSync(SessionId)
const decodeCommandId = Schema.decodeUnknownSync(CommandId)
const decodeEnvironment = Schema.decodeUnknownEffect(Environment)
const decodeRunId = Schema.decodeUnknownEffect(RunId)
const LEASE_JOB = 'workspace-lease'
const RENEW_AFTER_MS = 5 * 60 * 60 * 1_000
const INACTIVITY_MS = 6 * 60 * 60 * 1_000

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
export const makeDevelopmentSdk = Effect.gen(function* () {
  const state = yield* DurableObjectState
  const store = yield* Store
  const env = yield* WorkerEnvironment.pipe(Effect.flatMap(decodeEnvironment), Effect.orDie)
  const context = yield* Effect.context<DurableObjectState | import('alchemy/RuntimeContext').RuntimeContext>()
  const lock = yield* Semaphore.make(1)

  // Lifecycle's public constructor requires an actual native DurableObject host, and
  // withWorkspaceContainer reads that host's native ctx. Alchemy deliberately exposes
  // state.raw, not its generated host instance. Instantiate the official SDK mixins
  // with that exact state here only. The deployed DO remains Alchemy's Effect bridge,
  // application storage uses its Effect adapter, and no fake host or runtime is made.
  // SDK callbacks re-enter this captured activation context because the native SDK
  // invokes Promise callbacks outside Effect. No Layer is rebuilt per callback.
  // Alchemy names its native types through @cloudflare/workers-types, while these
  // SDKs use ambient Worker types mixed with the frontend DOM declarations. They
  // describe the same workerd objects but disagree structurally on Request and
  // WebSocket. Keep those declaration-only conversions at this SDK boundary.
  const host: SdkHost = new SdkHost(
    state.raw as unknown as ConstructorParameters<typeof DurableObject>[0],
    env,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const active = yield* state.storage.get<unknown>('active-run-id')
          if (active === undefined) return undefined
          const runId = yield* decodeRunId(active)
          const run = yield* store.getRun(runId)
          const container = host.getWorkspaceContainer()
          if (run.status === 'completed' || !(yield* Effect.promise(() => container.status())).running) return undefined
          yield* Effect.promise(() => container.setInactivityTimeout(INACTIVITY_MS))
          return { rescheduleAt: (yield* Clock.currentTimeMillis) + RENEW_AFTER_MS }
        }).pipe(Effect.provideContext(context)),
      ),
    async () => {
      const next = await host.renew()
      if (typeof next === 'object' && next !== null) {
        await lifecycle.jobs.push({ id: LEASE_JOB, fn: LEASE_JOB, time: next.rescheduleAt })
      }
    },
  )
  const { models, model } = makeDevelopmentModels({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
    apiKey: env.CLOUDFLARE_AI_GATEWAY_API_KEY,
  })
  const harness = new PiHarness({
    defaults: { model },
    harness: async ({ storage, context }) => {
      // This must remain isolate-local. WorkspaceStub extends capnweb.RpcTarget,
      // not Cloudflare's RpcTarget, and native service bindings cannot clone it.
      // Only start/resume's JSON wire contract is exported by the outer Effect DO.
      const workspace = await getWorkspace(host)
      const registry = createRegistry()
      registry.install({ name: 'workspace', tools: createWorkspaceTools(workspace) })
      return Harness.open(storage, { models, registry }, context)
    },
  })
  const lifecycle = new Lifecycle(host).use(harness)
  const io = <A>(evaluate: () => Promise<A>) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new ExternalError({ operation: 'access development sandbox', cause, kind: 'service' }),
    })
  const session = (status: Session['status']): Session => ({
    sessionId: decodeSessionId(ROOT_SESSION),
    model: model.id,
    status,
  })
  const sandbox = DevelopmentSandbox.of({
    ensureSession: (runId) =>
      lock.withPermit(
        Effect.gen(function* () {
          // The machine-owned Pi node acquires its resource here. Activation only
          // installs SDK descriptors, and cannot start a run or its workspace.
          yield* io(() => lifecycle.start())
          yield* state.storage.put('active-run-id', runId)
          const renewAt = (yield* Clock.currentTimeMillis) + RENEW_AFTER_MS
          yield* io(() => lifecycle.jobs.push({ id: LEASE_JOB, fn: LEASE_JOB, time: renewAt }))
          yield* io(() => harness.pi())
          const run = yield* store
            .getRun(runId)
            .pipe(
              Effect.mapError(
                (cause) => new ExternalError({ operation: 'read development run', kind: 'storage', cause }),
              ),
            )
          return session(run.status === 'completed' ? 'completed' : 'active')
        }).pipe(
          // The SDK adapter closes over its activation-owned native storage context.
          Effect.provideContext(context),
          Effect.mapError(
            (cause) => new ExternalError({ operation: 'initialize Pi resource', kind: 'service', cause }),
          ),
        ),
      ),
    submitTurn: (_runId, input) =>
      io(async (): Promise<TurnReceipt> => {
        const receipt = await harness.submit(input.prompt, { session: ROOT_SESSION, operationId: input.commandId })
        return { commandId: decodeCommandId(receipt.operationId), status: 'running' }
      }),
    getTurn: (_runId, commandId) =>
      io(async (): Promise<TurnReceipt | null> => {
        const pending = await harness.pending({ session: ROOT_SESSION })
        if (Array.some(pending, (operation) => operation.operationId === commandId))
          return { commandId, status: 'running' }
        const result = await harness.wait(commandId, { session: ROOT_SESSION })
        if (result.reason === 'not_found') return null
        return result.status === 'done'
          ? { commandId: decodeCommandId(result.operationId), status: 'completed', text: result.text ?? '' }
          : { commandId: decodeCommandId(result.operationId), status: 'failed', error: 'sdk_failure' }
      }),
    complete: (_runId) =>
      lock.withPermit(
        io(async () => {
          const pending = await harness.pending({ session: ROOT_SESSION })
          if (pending.length !== 0) throw new Error('Pi session still has pending work')
          // Keep the lease until renew observes the committed terminal run.
          // A failed final D1 ACK must leave the workspace recoverable.
          return session('completed')
        }),
      ),
  })
  return {
    sandbox,
    fetch: (request: Request) =>
      Effect.promise(async () => {
        const response = await host.backend.handleFetch(request)
        if (response.status === 101) await host.getWorkspaceContainer().setInactivityTimeout(INACTIVITY_MS)
        return response
      }),
    webSocketMessage: (socket: WorkerWebSocket, message: string | ArrayBuffer) =>
      Effect.promise(() => lifecycle.webSocketMessage(socket as unknown as WebSocket, message)),
    webSocketClose: (socket: WorkerWebSocket, code: number, reason: string, wasClean: boolean) =>
      Effect.promise(() => lifecycle.webSocketClose(socket as unknown as WebSocket, code, reason, wasClean)),
    webSocketError: (socket: WorkerWebSocket, error: unknown) =>
      Effect.promise(() => lifecycle.webSocketError(socket as unknown as WebSocket, error)),
    lifecycle,
  }
})
