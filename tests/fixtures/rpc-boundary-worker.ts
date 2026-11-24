import { WorkerEntrypoint } from 'cloudflare:workers'
import { Effect } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { rpcResult } from '@/core/feature/workflow/rpc/boundary'

import { loggedEntries, respond } from './rpc-boundary-worker-runtime.ts'
import type { ChildBinding, Scenario } from './rpc-boundary-worker-runtime.ts'

export { Child } from './rpc-boundary-child.ts'
export type { Scenario } from './rpc-boundary-worker-runtime.ts'

// oxlint-disable-next-line import/no-default-export -- Workerd resolves the default class as the parent service entrypoint.
export default class Parent extends WorkerEntrypoint<{ CHILD: ChildBinding }> {
  public async start(scenario: Scenario): Promise<string> {
    const result = Effect.tryPromise({
      catch: (cause) => new ExternalError({ cause, kind: 'service', operation: 'child transport' }),
      try: async () => this.env.CHILD.start(scenario),
    })
    const decoded = result.pipe(Effect.flatMap(rpcResult('child.start')))
    return respond('parent.start', decoded)
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- Workerd exposes this method on the default parent RPC entrypoint.
  public logs(): string {
    return loggedEntries()
  }
}
