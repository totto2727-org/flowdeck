import { getWorkspace, withWorkspace } from '@cloudflare/computer'
import type { WorkspaceOptions } from '@cloudflare/computer'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import { DurableObject } from 'cloudflare:workers'
import { Effect, MutableRef, Option, Predicate } from 'effect'

import { LocalShell } from './worker-shell-local.ts'
import { WORKER_SHELL_BACKEND } from './workspace.ts'

class WorkspaceDurableObject extends DurableObject {}

type RawState = DurableObjectState['Service']['raw']
type LocalHost = InstanceType<ReturnType<typeof withWorkspace<typeof WorkspaceDurableObject>>>
type HostReference = MutableRef.MutableRef<Option.Option<LocalHost>>
const contextParameter = 0
type ShellContext = ConstructorParameters<typeof LocalShell>[typeof contextParameter]
type DurableContext = ConstructorParameters<typeof WorkspaceDurableObject>[typeof contextParameter]
const environmentParameter = 1
type ShellEnvironment = ConstructorParameters<typeof LocalShell>[typeof environmentParameter]

const openLocalStub = async (current: HostReference): ReturnType<ShellEnvironment['HOST']['getWorkspace']> => {
  const host = Option.getOrThrow(MutableRef.get(current))
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Use the official local stub so the Worker shell retains its SDK-owned disposal.
  const stub = await host.__getWorkspaceStub()
  const { assets } = stub
  // The Workspace getter can return undefined. The shell host models that capability with an optional property.
  return {
    artifacts: stub.artifacts,
    fs: stub.fs,
    git: stub.git,
    ...(Predicate.isNullish(assets) ? {} : { assets }),
    [Symbol.dispose]: () => {
      stub[Symbol.dispose]()
    },
  }
}

const shellBackend = (state: RawState, current: HostReference): WorkerShellBackend => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Alchemy and the SDK declare the same native workerd context under different types.
  const context = state as unknown as ShellContext
  const environment = { HOST: { getWorkspace: async () => openLocalStub(current) } }
  return new WorkerShellBackend({
    egress: { mode: 'none' },
    id: WORKER_SHELL_BACKEND,
    source: {
      // Dispatch, cancellation, and exec events stay owned by the native SDK.
      connect: () => new LocalShell(context, environment),
      type: 'external-runtime',
    },
  })
}

const createWorkspaceHost = (state: RawState): LocalHost => {
  const current = MutableRef.make(Option.none<LocalHost>())
  const options: WorkspaceOptions = { backends: [shellBackend(state, current)], storage: state.storage }
  const WorkspaceHost = withWorkspace(WorkspaceDurableObject, () => options)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the real Alchemy durable object state under Cloudflare's native declaration.
  const host = new WorkspaceHost(state as unknown as DurableContext, {})
  // The SDK connects lazily after host construction.
  MutableRef.set(current, Option.some(host))
  return host
}

// The official binding uses the durable host's SQLite and isolates shell execution.
export const makeWorkerShellWorkspace = Effect.gen(function* () {
  const state = yield* DurableObjectState
  const host = createWorkspaceHost(state.raw)
  const workspace = yield* Effect.acquireRelease(
    Effect.promise(async () => getWorkspace(host)),
    // Release the runtime client while retaining durable SQLite and host identity.
    (client) =>
      Effect.sync(() => {
        client[Symbol.dispose]()
      }),
  )
  return { host, workspace }
})
