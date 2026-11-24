import { WorkerEntrypoint } from 'cloudflare:workers'
import { Effect } from 'effect'

import { ExternalError, NotFound } from '@/core/feature/workflow/domain/errors'

import { absentJson, loggedEntries, respond } from './rpc-boundary-worker-runtime.ts'
import type { Scenario } from './rpc-boundary-worker-runtime.ts'

const originalError = (): Error => {
  // oxlint-disable-next-line rules/require-tagged-error -- The native-isolate test sends an ordinary non-serializable Error as the defect.
  const error = new Error('PRIVATE_RPC_DATABASE_PASSWORD')
  error.stack = 'Error: PRIVATE_RPC_DATABASE_PASSWORD\n    at childOnlyPrivateFrame (private-storage.ts:91:7)'
  error.cause = { cycle: error, nonJsonValue: BigInt('123') }
  return error
}

export class Child extends WorkerEntrypoint {
  // oxlint-disable-next-line eslint/class-methods-use-this -- Workerd exposes this method on the named Child RPC entrypoint.
  public async start(scenario: Scenario): Promise<string> {
    if (scenario === 'success') {
      return respond('child.start', Effect.succeed({ answer: 42, values: [absentJson, true, 'ok'] }))
    }
    const original = originalError()
    if (scenario === 'not-found') {
      const error = new NotFound({ resource: 'PRIVATE_RPC_DATABASE_PASSWORD' })
      error.stack = original.stack ?? ''
      return respond('child.start', Effect.fail(error))
    }
    const failure =
      scenario === 'defect'
        ? Effect.die(original)
        : Effect.fail(new ExternalError({ cause: original, kind: 'storage', operation: 'private SQL query' }))
    return respond('child.start', failure)
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- Workerd exposes this method on the named Child RPC entrypoint.
  public logs(): string {
    return loggedEntries()
  }
}
