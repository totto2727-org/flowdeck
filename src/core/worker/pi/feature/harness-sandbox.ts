import type { PiHarness } from 'agents/harness/pi'
import { ROOT_SESSION } from 'agents/harness/pi'
import type { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Array, Effect, Result, Schema, Semaphore } from 'effect'

import { CommandId, SessionId } from '@/core/feature/pi/model'
import type { Session, TurnReceipt } from '@/core/feature/pi/model'
import { PiSandbox } from '@/core/feature/pi/sandbox'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'
import { Store } from '@/core/feature/workflow/services/store'

const decodeSessionId = Schema.decodeUnknownResult(SessionId)
const decodeCommandId = Schema.decodeEffect(CommandId)

const sandboxError = (cause: unknown): ExternalError =>
  new ExternalError({ cause, kind: 'service', operation: 'access Pi sandbox' })

const validateCommandId = (operationId: string): Effect.Effect<CommandId, ExternalError> =>
  decodeCommandId(operationId).pipe(Effect.mapError(sandboxError))

type SandboxRequirements = DurableObjectState | RuntimeContext

/** Native PiHarness operations share one receipt contract regardless of the Workspace backend. */
export const makeHarnessSandbox = (
  options: Readonly<{
    harness: PiHarness
    modelId: string
    initialize: (runId: RunId) => Effect.Effect<void, unknown, SandboxRequirements>
  }>,
) =>
  Effect.gen(function* () {
    const store = yield* Store
    const context = yield* Effect.context<SandboxRequirements>()
    const lock = yield* Semaphore.make(1)
    const io = <A>(evaluate: () => Promise<A>): Effect.Effect<A, ExternalError> =>
      Effect.tryPromise({
        catch: sandboxError,
        try: evaluate,
      })
    const session = (status: Session['status']): Session => ({
      sessionId: Result.getOrThrow(decodeSessionId(ROOT_SESSION)),
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
            /*
             * The SDK invokes native Promise callbacks outside Effect. Reenter the
             * activation-owned context without rebuilding its Layer or closing its DO.
             */
            Effect.provideContext(context),
            Effect.mapError(
              (cause) => new ExternalError({ operation: 'initialize Pi resource', kind: 'service', cause }),
            ),
          ),
        ),
      submitTurn: (_runId, input) =>
        Effect.gen(function* () {
          const receipt = yield* io(async () =>
            options.harness.submit(input.prompt, {
              operationId: input.commandId,
              session: ROOT_SESSION,
            }),
          )
          const commandId = yield* validateCommandId(receipt.operationId)
          return { commandId, status: 'running' } satisfies TurnReceipt
        }),
      getTurn: (_runId, commandId) =>
        Effect.gen(function* () {
          const pending = yield* io(async () => options.harness.pending({ session: ROOT_SESSION }))
          if (Array.some(pending, (operation) => operation.operationId === commandId)) {
            return { commandId, status: 'running' } satisfies TurnReceipt
          }
          const result = yield* io(async () => options.harness.wait(commandId, { session: ROOT_SESSION }))
          if (result.reason === 'not_found') {
            return null
          }
          const receivedId = yield* validateCommandId(result.operationId)
          return result.status === 'done'
            ? ({ commandId: receivedId, status: 'completed', text: result.text ?? '' } satisfies TurnReceipt)
            : ({ commandId: receivedId, error: 'sdk_failure', status: 'failed' } satisfies TurnReceipt)
        }),
      complete: (_runId) =>
        lock.withPermit(
          io(async () => {
            const pending = await options.harness.pending({ session: ROOT_SESSION })
            if (Array.isReadonlyArrayNonEmpty(pending)) {
              throw new Error('Pi session still has pending work')
            }
            /*
             * Completion is only an acknowledgement. Durable storage and any
             * backend retention remain owned by the run and its native lifecycle.
             */
            return session('completed')
          }),
        ),
    })
  })
