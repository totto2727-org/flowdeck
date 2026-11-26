import type { PiHarness } from 'agents/harness/pi'
import { ROOT_SESSION } from 'agents/harness/pi'
import type { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Array, Data, Effect, Result, Schema, Semaphore } from 'effect'

import { CommandId, SessionId } from '@/core/feature/pi/model'
import type { Session, TurnReceipt } from '@/core/feature/pi/model'
import { PiSandbox } from '@/core/feature/pi/sandbox'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'
import { Store } from '@/core/feature/workflow/services/store'

const decodeSessionId = Schema.decodeUnknownResult(SessionId)
const decodeCommandId = Schema.decodeEffect(CommandId)
const sessionLockPermits = 1

const sandboxError = (cause: unknown): ExternalError =>
  new ExternalError({ cause, kind: 'service', operation: 'access Pi sandbox' })

const sandboxIO = <A>(evaluate: () => Promise<A>): Effect.Effect<A, ExternalError> =>
  Effect.tryPromise({ catch: sandboxError, try: evaluate })

const validateCommandId = (operationId: string): Effect.Effect<CommandId, ExternalError> =>
  decodeCommandId(operationId).pipe(Effect.mapError(sandboxError))

class PendingPiWork extends Data.TaggedError('PendingPiWork')<{ message: string }> {}

type SandboxRequirements = DurableObjectState | RuntimeContext

interface HarnessOptions {
  harness: PiHarness
  initialize: (runId: RunId) => Effect.Effect<void, unknown, SandboxRequirements>
  modelId: string
}

type Sandbox = typeof PiSandbox.Service

const makeTurnOperations = (harness: PiHarness): Pick<Sandbox, 'getTurn' | 'submitTurn'> => ({
  getTurn: (_runId, commandId) =>
    Effect.gen(function* () {
      const pending = yield* sandboxIO(async () => harness.pending({ session: ROOT_SESSION }))
      if (Array.some(pending, (operation) => operation.operationId === commandId)) {
        return { commandId, status: 'running' } satisfies TurnReceipt
      }
      const result = yield* sandboxIO(async () => harness.wait(commandId, { session: ROOT_SESSION }))
      if (result.reason === 'not_found') {
        // oxlint-disable-next-line unicorn/no-null -- PiSandbox uses null for an authoritative turn_not_found reply.
        return null
      }
      const receivedId = yield* validateCommandId(result.operationId)
      return result.status === 'done'
        ? ({ commandId: receivedId, status: 'completed', text: result.text ?? '' } satisfies TurnReceipt)
        : ({ commandId: receivedId, error: 'sdk_failure', status: 'failed' } satisfies TurnReceipt)
    }),
  submitTurn: (_runId, input) =>
    Effect.gen(function* () {
      const receipt = yield* sandboxIO(async () =>
        harness.submit(input.prompt, {
          operationId: input.commandId,
          session: ROOT_SESSION,
        }),
      )
      const commandId = yield* validateCommandId(receipt.operationId)
      return { commandId, status: 'running' } satisfies TurnReceipt
    }),
})

const session = (modelId: string, status: Session['status']): Session => ({
  model: modelId,
  sessionId: Result.getOrThrow(decodeSessionId(ROOT_SESSION)),
  status,
})

const completeSession = (harness: PiHarness, modelId: string): Effect.Effect<Session, ExternalError> =>
  sandboxIO(async () => {
    const pending = await harness.pending({ session: ROOT_SESSION })
    if (Array.isReadonlyArrayNonEmpty(pending)) {
      throw new PendingPiWork({ message: 'Pi session still has pending work' })
    }
    // The run and native lifecycle retain ownership of durable storage.
    return session(modelId, 'completed')
  })

// Native PiHarness operations share one receipt contract across workspace backends.
export const makeHarnessSandbox = (
  options: HarnessOptions,
): Effect.Effect<Sandbox, never, SandboxRequirements | Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    const context = yield* Effect.context<SandboxRequirements>()
    const lock = yield* Semaphore.make(sessionLockPermits)
    return PiSandbox.of({
      complete: () => lock.withPermit(completeSession(options.harness, options.modelId)),
      ensureSession: (runId) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* options.initialize(runId)
            yield* sandboxIO(async () => options.harness.pi())
            const run = yield* store
              .getRun(runId)
              .pipe(Effect.mapError((cause) => new ExternalError({ cause, kind: 'storage', operation: 'read Pi run' })))
            return session(options.modelId, run.status === 'completed' ? 'completed' : 'active')
          }).pipe(
            // SDK callbacks re-enter the activation-owned context without rebuilding its Layer.
            Effect.provideContext(context),
            Effect.mapError(
              (cause) => new ExternalError({ cause, kind: 'service', operation: 'initialize Pi resource' }),
            ),
          ),
        ),
      ...makeTurnOperations(options.harness),
    })
  })
