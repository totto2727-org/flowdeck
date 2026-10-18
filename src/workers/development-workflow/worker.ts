import { getWorkspace, withWorkspace, type WorkspaceOptions } from '@cloudflare/computer'
import { ContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { PiHarness, ROOT_SESSION } from 'agents/harness/pi'
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle'
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { Array, Effect, Semaphore } from 'effect'

import type { Session, TurnReceipt } from '../../features/development/model'
import { BindingError } from '../../features/workflow/domain/errors'
import { makeD1Store } from '../../features/workflow/services/d1-store'
import { Store } from '../../features/workflow/services/store'
import type { DevelopmentEnvironment } from './container'
import { resumeDevelopmentRun, startDevelopmentRun } from './features/development'
import { makeDevelopmentModels } from './features/models'
import { DevelopmentSandbox } from './features/sandbox'
import { CONTAINER_BACKEND, createWorkspaceTools } from './features/workspace'

export { WorkspaceProxy } from '@cloudflare/computer'

const LEASE_JOB = 'workspace-lease'
const RENEW_AFTER_MS = 5 * 60 * 60 * 1_000
const INACTIVITY_MS = 6 * 60 * 60 * 1_000

/** Construct the backend before withWorkspace evaluates its options callback. */
class DevelopmentContainerBase extends withWorkspaceContainer(class extends DurableObject<DevelopmentEnvironment> {}) {
  readonly backend = new ContainerBackend({
    container: () => this,
    workspace: { binding: 'DevelopmentRun', id: this.ctx.id.toString() },
    egress: { mode: 'direct' },
    id: CONTAINER_BACKEND,
    name: 'JcodeSandbox',
    instance: 'standard-1',
  })
}

function workspaceOptions(self: DevelopmentContainerBase): WorkspaceOptions {
  // withWorkspace invokes this before subclass fields exist, as in the official container example.
  const { ctx } = self as unknown as { ctx: DurableObjectState }
  return { storage: ctx.storage, backends: [self.backend] }
}

/** Native runtime shell. Pi owns durable submissions and execution, D1 owns workflow state. */
export class DevelopmentRun extends withWorkspace(DevelopmentContainerBase, workspaceOptions) {
  readonly #lifecycle: Lifecycle<DevelopmentEnvironment>
  readonly #harness: PiHarness
  readonly #store: ReturnType<typeof makeD1Store>
  readonly #modelId: string
  readonly #lock = Effect.runSync(Semaphore.make(1))

  constructor(ctx: DurableObjectState, env: DevelopmentEnvironment) {
    super(ctx, env)
    this.#store = makeD1Store(env.DATABASE)
    const { models, model } = makeDevelopmentModels({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
      apiKey: env.CLOUDFLARE_AI_GATEWAY_API_KEY,
    })
    this.#modelId = model.id
    this.#harness = new PiHarness({
      defaults: { model },
      harness: async ({ storage, context }) => {
        const workspace = await getWorkspace(this)
        const registry = createRegistry()
        registry.install({ name: 'workspace', tools: createWorkspaceTools(workspace) })
        return Harness.open(storage, { models, registry }, context)
      },
    })
    this.#lifecycle = Lifecycle.install(this).use(this.#harness)
  }

  // computerd's WebSocket upgrade belongs to ContainerBackend, not Lifecycle's client socket router.
  override async fetch(request: Request): Promise<Response> {
    const response = await this.backend.handleFetch(request)
    if (response.status === 101) {
      await this.getWorkspaceContainer().setInactivityTimeout(INACTIVITY_MS)
    }
    return response
  }

  async onStart(): Promise<void> {
    const next = await this.#renewLease()
    if (next !== undefined) {
      await this.#lifecycle.jobs.push({ id: LEASE_JOB, fn: LEASE_JOB, time: next.rescheduleAt })
    }
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn === LEASE_JOB) return this.#renewLease()
    return undefined
  }

  async #renewLease(): Promise<{ rescheduleAt: number } | undefined> {
    const runId = await this.ctx.storage.get<string>('active-run-id')
    if (runId === undefined) return
    const run = await Effect.runPromise(this.#store.getRun(runId))
    const container = this.getWorkspaceContainer()
    // Failed workspaces remain inspectable. Renewal never starts a stopped container.
    if (run.status === 'completed' || !(await container.status()).running) return
    await container.setInactivityTimeout(INACTIVITY_MS)
    return { rescheduleAt: Date.now() + RENEW_AFTER_MS }
  }

  #sandbox(): DevelopmentSandbox['Service'] {
    const io = <A>(evaluate: () => Promise<A>) =>
      Effect.tryPromise({ try: evaluate, catch: (cause) => new BindingError({ cause }) })
    const session = (status: Session['status']): Session => ({
      sessionId: ROOT_SESSION,
      model: this.#modelId,
      status,
    })
    return DevelopmentSandbox.of({
      ensureSession: (runId) =>
        io(async () => {
          await this.#harness.pi()
          const run = await Effect.runPromise(this.#store.getRun(runId))
          return session(run.status === 'completed' ? 'completed' : 'active')
        }),
      submitTurn: (_runId, input) =>
        io(async (): Promise<TurnReceipt> => {
          const receipt = await this.#harness.submit(input.prompt, {
            session: ROOT_SESSION,
            operationId: input.commandId,
          })
          return { commandId: receipt.operationId, status: 'running' }
        }),
      getTurn: (_runId, commandId) =>
        io(async (): Promise<TurnReceipt | null> => {
          const pending = await this.#harness.pending({ session: ROOT_SESSION })
          if (Array.some(pending, (operation) => operation.operationId === commandId)) {
            return { commandId, status: 'running' }
          }
          const result = await this.#harness.wait(commandId, { session: ROOT_SESSION })
          if (result.reason === 'not_found') return null
          return result.status === 'done'
            ? { commandId: result.operationId, status: 'completed', text: result.text ?? '' }
            : { commandId: result.operationId, status: 'failed', error: 'sdk_failure' }
        }),
      complete: (_runId) =>
        io(async () => {
          const pending = await this.#harness.pending({ session: ROOT_SESSION })
          if (pending.length !== 0) throw new Error('Pi session still has pending work')
          // The workflow's D1 Completed checkpoint is canonical. Do not reset Pi or destroy its workspace.
          return session('completed')
        }),
    })
  }

  async #execute(runId: string, operation: ReturnType<typeof startDevelopmentRun>): Promise<void> {
    await this.#lifecycle.start()
    await Effect.runPromise(
      this.#lock.withPermit(
        Effect.gen({ self: this }, function* () {
          yield* Effect.promise(() => this.ctx.storage.put('active-run-id', runId))
          // Schedule before admission, including when Pi has not launched its first shell yet.
          yield* Effect.promise(() =>
            this.#lifecycle.jobs.push({
              id: LEASE_JOB,
              fn: LEASE_JOB,
              time: Date.now() + RENEW_AFTER_MS,
            }),
          )
          yield* operation
          const run = yield* this.#store.getRun(runId)
          if (run.status === 'completed') {
            yield* Effect.promise(() => this.#lifecycle.jobs.cancel(LEASE_JOB))
          }
        }).pipe(Effect.provideService(Store, this.#store), Effect.provideService(DevelopmentSandbox, this.#sandbox())),
      ),
    )
  }

  start(runId: string): Promise<void> {
    return this.#execute(runId, startDevelopmentRun(runId))
  }

  resume(runId: string): Promise<void> {
    return this.#execute(runId, resumeDevelopmentRun(runId))
  }
}

/** Native service-binding entrypoint. Business effects remain inside the per-run Durable Object. */
export default class DevelopmentEntrypoint extends WorkerEntrypoint<
  DevelopmentEnvironment & { DevelopmentRun: DurableObjectNamespace<DevelopmentRun> }
> {
  start(runId: string): Promise<void> {
    return this.env.DevelopmentRun.getByName(runId).start(runId)
  }

  resume(runId: string): Promise<void> {
    return this.env.DevelopmentRun.getByName(runId).resume(runId)
  }
}
