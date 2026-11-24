import { Effect } from 'effect'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import { makeRpcResponse } from '@/core/feature/workflow/rpc/boundary'
import { rpcCall, rpcCommandResult } from '@/core/feature/workflow/rpc/contract'
import { PiRun } from '@/core/worker/pi/run'
import { commandAcknowledgement, decodeRunId } from '@/user-land/workflow/run-wire'

export const forwardDevelopmentRun = Effect.gen(function* () {
  const runs = yield* PiRun
  const respond = yield* makeRpcResponse
  const command = (operation: 'start' | 'resume') => (input: RunId) =>
    decodeRunId(input).pipe(
      // Decode the native input before namespace selection or Durable Object activation.
      Effect.flatMap((runId) => {
        const run = runs.getByName(runId)
        return run[operation](runId).pipe(rpcCall(`DevelopmentRun.${operation}`))
      }),
      Effect.flatMap(rpcCommandResult(`DevelopmentRun.${operation}`)),
      Effect.as(commandAcknowledgement),
      respond(`DevelopmentWorkflow.${operation}`),
    )
  return { resume: command('resume'), start: command('start') }
})
