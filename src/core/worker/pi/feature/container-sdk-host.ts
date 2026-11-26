import { withWorkspace } from '@cloudflare/computer'
import type { LifecycleJobContext, LifecycleJobOutcome } from 'agents/lifecycle'

import { ContainerHost } from './container-host.ts'
import type { ContainerEnvironment } from './container-host.ts'
import { leaseJob } from './container-lease.ts'

interface LeaseCallbacks {
  renew: (host: ContainerHost) => Promise<{ rescheduleAt: number } | undefined>
  start: (host: ContainerHost) => Promise<void>
}

// Alchemy owns the deployed DO. Its SDK adapter is the real native host used by Workspace and Lifecycle.
export class ContainerSdkHost extends withWorkspace(ContainerHost, (host) => host.workspaceOptions()) {
  #callbacks: LeaseCallbacks

  public constructor(state: globalThis.DurableObjectState, env: ContainerEnvironment, callbacks: LeaseCallbacks) {
    super(state, env)
    this.#callbacks = callbacks
  }

  public async onStart(): Promise<void> {
    return this.#callbacks.start(this)
  }

  public async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return job.fn === leaseJob ? this.#callbacks.renew(this) : undefined
  }
}
