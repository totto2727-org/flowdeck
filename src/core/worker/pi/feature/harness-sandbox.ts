import type { PiHarness } from 'agents/harness/pi'
import { ROOT_SESSION } from 'agents/harness/pi'
import { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import { Array, Effect, Schema, Semaphore } from 'effect'

import { CommandId, SessionId, type Session, type TurnReceipt } from '@/core/feature/pi/model'
import { PiSandbox } from '@/core/feature/pi/sandbox'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'
import { Store } from '@/core/feature/workflow/services/store'

const decodeSessionId = Schema.decodeUnknownSync(SessionId)
const decodeCommandId = Schema.decodeUnknownSync(CommandId)

/** Native PiHarness operations share one receipt contract regardless of the Workspace backend. */
export const makeHarnessSandbox = (options: {
  readonly harness: PiHarness
  readonly modelId: string
  readonly initialize: (
    runId: RunId,
  ) => Effect.Effect<void, unknown, DurableObjectState | import('alchemy/RuntimeContext').RuntimeContext>
}) =>
  Effect.gen(function* () {
    const store = yield* Store
    const context = yield* Effect.context<DurableObjectState | import('alchemy/RuntimeContext').RuntimeContext>()
    const lock = yield* Semaphore.make(1)
    const io = <A>(evaluate: () => Promise<A>) =>
      Effect.tryPromise({
        try: evaluate,
        catch: (cause) => new ExternalError({ operation: 'access Pi sandbox', cause, kind: 'service' }),
      })
    const session = (status: Session['status']): Session => ({
      sessionId: decodeSessionId(ROOT_SESSION),
      model: options.modelId,
      status,
    })
    return PiSandbox.of({
      ensureSession: (runId) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* options.initialize(runId)
            yield* io(() => options.harness.pi())
            const run = yield* store
              .getRun(runId)
              .pipe(Effect.mapError((cause) => new ExternalError({ operation: 'read Pi run', kind: 'storage', cause })))
            return session(run.status === 'completed' ? 'completed' : 'active')
          }).pipe(
            // The SDK invokes native Promise callbacks outside Effect. Reenter the
            // activation-owned context without rebuilding its Layer or closing its DO.
            Effect.provideContext(context),
            Effect.mapError(
              (cause) => new ExternalError({ operation: 'initialize Pi resource', kind: 'service', cause }),
            ),
          ),
        ),
      submitTurn: (_runId, input) =>
        io(async (): Promise<TurnReceipt> => {
          const receipt = await options.harness.submit(input.prompt, {
            session: ROOT_SESSION,
            operationId: input.commandId,
          })
          return { commandId: decodeCommandId(receipt.operationId), status: 'running' }
        }),
      getTurn: (_runId, commandId) =>
        io(async (): Promise<TurnReceipt | null> => {
          const pending = await options.harness.pending({ session: ROOT_SESSION })
          if (Array.some(pending, (operation) => operation.operationId === commandId))
            return { commandId, status: 'running' }
          const result = await options.harness.wait(commandId, { session: ROOT_SESSION })
          if (result.reason === 'not_found') return null
          return result.status === 'done'
            ? { commandId: decodeCommandId(result.operationId), status: 'completed', text: result.text ?? '' }
            : { commandId: decodeCommandId(result.operationId), status: 'failed', error: 'sdk_failure' }
        }),
      complete: (_runId) =>
        lock.withPermit(
          io(async () => {
            const pending = await options.harness.pending({ session: ROOT_SESSION })
            if (pending.length !== 0) throw new Error('Pi session still has pending work')
            // Completion is only an acknowledgement. Durable storage and any
            // backend retention remain owned by the run and its native lifecycle.
            return session('completed')
          }),
        ),
    })
  })
