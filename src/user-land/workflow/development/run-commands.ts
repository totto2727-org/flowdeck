import type { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Context, Effect } from 'effect'
import type { Layer } from 'effect'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import { makeRpcResponse } from '@/core/feature/workflow/rpc/boundary'
import { PiSdk } from '@/core/worker/pi/sdk-service'
import { commandAcknowledgement, decodeRunId } from '@/user-land/workflow/run-wire'

import { DevelopmentExecutor } from './feature/development.ts'
import { exposeDevelopmentNative } from './run-native.ts'
import type { makeDevelopmentRunRuntime } from './run-runtime.ts'

type Services = Layer.Success<Effect.Success<typeof makeDevelopmentRunRuntime>>
type ActivationContext = Context.Context<Services | DurableObjectState | RuntimeContext>

export const exposeDevelopmentCommands = Effect.fn('flowdeck.development.exposeRunCommands')(function* (
  services: Context.Context<Services>,
  context: ActivationContext,
) {
  const sdk = Context.get(services, PiSdk)
  const executor = Context.get(services, DevelopmentExecutor)
  const respond = yield* makeRpcResponse.pipe(Effect.provideContext(context))
  const command = (operation: string, execute: typeof executor.start) => (input: RunId) =>
    decodeRunId(input).pipe(
      Effect.flatMap(execute),
      Effect.as(commandAcknowledgement),
      respond(operation),
      // Cloudflare invokes each exported callback with the context captured at activation.
      Effect.provideContext(context),
    )
  const native = yield* exposeDevelopmentNative(sdk)
  return {
    ...native,
    resume: command('DevelopmentRun.resume', executor.resume),
    start: command('DevelopmentRun.start', executor.start),
  }
})
