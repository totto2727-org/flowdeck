import { getWorkspace, withWorkspace, type WorkspaceOptions } from '@cloudflare/computer'
import { ShellWorker, WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import { DurableObject } from 'cloudflare:workers'
import { Effect } from 'effect'

import { WORKER_SHELL_BACKEND } from './workspace'

// The official external-runtime connector runs this official shell in the host
// isolate. Unlike Loader mode, it does not clone Capnweb WorkspaceStub through
// native Workers RPC. Keep network disabled at the official shell fetch hook.
class LocalShell extends ShellWorker {
  protected override readonly shellOptions = { fetch: null }
}

/** SQLite Workspace and official just-bash shell, without Container or Loader bindings. */
export const makeWorkerShellWorkspace = Effect.gen(function* () {
  const state = yield* DurableObjectState
  // SDK constructors require native host contexts. Alchemy exposes this same
  // runtime state under workers-types declarations, so declaration-only casts
  // stay here at the adapter. No new durable identity or mock host is created.
  class WorkspaceHost extends withWorkspace(class extends DurableObject {}, (): WorkspaceOptions => ({
    storage: state.raw.storage,
    backends: [
      new WorkerShellBackend({
        id: WORKER_SHELL_BACKEND,
        egress: { mode: 'none' },
        source: {
          type: 'external-runtime',
          // Connect is lazy, after the local host has completed construction.
          // All dispatch, cancellation and exec events remain SDK-owned.
          connect: () =>
            new LocalShell(state.raw as unknown as ConstructorParameters<typeof ShellWorker>[0], {
              HOST: {
                getWorkspace: async () => {
                  const stub = await host.__getWorkspaceStub()
                  const assets = stub.assets
                  // Computer's WorkspaceStub has an always-present getter that
                  // can return undefined. Its ShellWorker instead declares an
                  // absent optional property under exactOptionalPropertyTypes.
                  // Preserve that official capability contract without a cast
                  // or a fabricated asset service, and retain SDK disposal.
                  return {
                    fs: stub.fs,
                    git: stub.git,
                    artifacts: stub.artifacts,
                    ...(assets === undefined ? {} : { assets }),
                    [Symbol.dispose]: () => stub[Symbol.dispose](),
                  }
                },
              },
            }),
        },
      }),
    ],
  })) {}
  const host = new WorkspaceHost(state.raw as unknown as ConstructorParameters<typeof DurableObject>[0], {})
  const workspace = yield* Effect.acquireRelease(
    Effect.promise(() => getWorkspace(host)),
    // Release the volatile client only. Never delete SQLite, destroy the host,
    // or stop a durable run when its execution/activation Scope ends.
    (client) => Effect.sync(() => client[Symbol.dispose]()),
  )
  return { host, workspace }
})
