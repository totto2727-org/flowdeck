import { Context, Data, Effect, Predicate, Schema } from 'effect'

import { makeExecutionIdGenerator, ExecutionId } from '@/core/feature/workflow/domain/identity'
import { WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'
import type { EventDraft } from '@/core/feature/workflow/managed-runtime'
import { ResourceStore } from '@/core/feature/workflow/resource-store'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'

import { CommandId, makeCommandIdGenerator, SessionId } from './model.ts'
import type { TurnReceipt } from './model.ts'
import { PiSandbox } from './sandbox.ts'

const initialAttempt = 1
const isOriginalSession = Schema.is(SessionId)

// Preserve the field encoding order in persisted development snapshots.
export const PiExecutionFields = {
  executionId: ExecutionId,
  commandId: CommandId,
  attempt: Schema.Literal(initialAttempt),
}
// oxlint-disable-next-line eslint/no-redeclare -- Preserve the schema and inferred type exports.
export const PiExecution = Schema.Struct(PiExecutionFields)
export type PiExecution = typeof PiExecution.Type
// Preserve the execution field order used in persisted development snapshots.
export const piExecutionData = (execution: PiExecution): PiExecution => ({
  executionId: execution.executionId,
  commandId: execution.commandId,
  attempt: execution.attempt,
})
// oxlint-disable-next-line eslint/no-redeclare -- Preserve the schema and inferred type exports.
export const PiResult = Schema.Struct({ ...PiExecutionFields, result: Schema.String })
export type PiResult = typeof PiResult.Type
export type PiOutcome = Data.TaggedEnum<{
  // oxlint-disable-next-line typescript/ban-types, typescript/no-empty-object-type -- Waiting is an Effect tagged enum case with no payload.
  Waiting: {}
  Completed: Readonly<{ result: string }>
  Failed: Readonly<{ message: string }>
}>
const outcome = Data.taggedEnum<PiOutcome>()

interface PiEventInput {
  execution: PiExecution
  nodeId: string
  payload?: EventDraft['payload']
  type: 'node.started' | 'node.succeeded' | 'node.failed' | 'run.waiting'
}

export const piNodeEvent = ({ execution, nodeId, payload = {}, type }: PiEventInput): EventDraft => ({
  attempt: execution.attempt,
  executionId: execution.executionId,
  nodeId,
  payload,
  type,
})

const receiptOutcome = (receipt: TurnReceipt, commandId: CommandId): PiOutcome => {
  if (receipt.commandId !== commandId) {
    return outcome.Failed({ message: 'Gateway returned a different command identity' })
  }
  if (receipt.status === 'running') {
    return outcome.Waiting()
  }
  if (receipt.status === 'completed') {
    return outcome.Completed({ result: receipt.text })
  }
  return outcome.Failed({ message: receipt.error })
}

type Capability = Effect.Effect<typeof PiSandbox.Service, never, ResourceStore>

const withCheckpoint = <A, R>(
  operation: (checkpoint: typeof WorkflowCheckpoint.Service) => Effect.Effect<A, WorkflowFailure, R>,
): Effect.Effect<A, never, R | WorkflowCheckpoint> =>
  Effect.flatMap(WorkflowCheckpoint, (checkpoint) =>
    Effect.matchEffect(operation(checkpoint), { onFailure: checkpoint.fail, onSuccess: Effect.succeed }),
  )

type PiStep<Input> = (input: Input) => Effect.Effect<PiOutcome, never, ResourceStore | WorkflowCheckpoint>
type SubmitInput = Readonly<{ execution: PiExecution; prompt: string }>

const submitTurn = (capability: Capability): PiStep<SubmitInput> =>
  Effect.fn('flowdeck.submitPiTurn')(function* (input: SubmitInput) {
    return yield* withCheckpoint((checkpoint) =>
      Effect.gen(function* () {
        const provider = yield* capability
        const session = yield* provider.ensureSession(checkpoint.runId)
        if (session.status !== 'active') {
          return outcome.Failed({
            message: 'The original active Pi session is unavailable. Container retained for inspection.',
          })
        }
        // Only authoritative absence permits resubmitting this exact operation on the submission path.
        const existing = yield* provider.getTurn(checkpoint.runId, input.execution.commandId)
        const receipt =
          existing ??
          (yield* provider.submitTurn(checkpoint.runId, {
            commandId: input.execution.commandId,
            prompt: input.prompt,
          }))
        const result = receiptOutcome(receipt, input.execution.commandId)
        return outcome.$is('Failed')(result) ? result : outcome.Waiting()
      }),
    )
  })

const pollTurn = (capability: Capability): PiStep<PiExecution> =>
  Effect.fn('flowdeck.pollPiTurn')(function* (execution: PiExecution) {
    return yield* withCheckpoint((checkpoint) =>
      Effect.gen(function* () {
        const provider = yield* capability
        // Explicit Resume reads the Harness operation without submitting it again.
        const receipt = yield* provider.getTurn(checkpoint.runId, execution.commandId)
        // oxlint-disable-next-line rules/prefer-is-nullish -- Only the sandbox's authoritative null reply represents an absent turn.
        return Predicate.isNull(receipt)
          ? outcome.Failed({ message: 'A submitted turn is missing. It will not be resubmitted automatically.' })
          : receiptOutcome(receipt, execution.commandId)
      }),
    )
  })

const completeTurn = (capability: Capability): PiStep<PiResult> =>
  Effect.fn('flowdeck.completePiTurn')(function* (result: PiResult) {
    return yield* withCheckpoint((checkpoint) =>
      Effect.gen(function* () {
        // A failed terminal D1 commit resumes here after the turn result and identity were saved.
        yield* checkpoint.checkpoint([])
        const provider = yield* capability
        const original = yield* provider.ensureSession(checkpoint.runId)
        if (!isOriginalSession(original.sessionId)) {
          return outcome.Failed({ message: 'The original Pi session is unavailable for completion' })
        }
        const session = yield* provider.complete(checkpoint.runId)
        return isOriginalSession(session.sessionId) && session.status === 'completed'
          ? outcome.Completed({ result: result.result })
          : outcome.Failed({ message: 'Could not complete the original Pi session' })
      }),
    )
  })

// The owning native states choose initialization, submission, polling and completion.
export const makePiNodeEffects = Effect.gen(function* () {
  const sandbox = yield* PiSandbox
  const executionId = yield* makeExecutionIdGenerator
  const commandId = yield* makeCommandIdGenerator
  // Keep the live Harness capability in the volatile resource scope.
  const capability = Effect.flatMap(ResourceStore, (resources) =>
    resources.getOrTryInit(PiSandbox, Effect.succeed(sandbox)),
  )
  const allocate = withCheckpoint(() =>
    Effect.gen(function* () {
      const execution = yield* executionId()
      const command = yield* commandId()
      // The allocation fields enter persisted development snapshots in this order.
      return { executionId: execution, commandId: command, attempt: initialAttempt } satisfies PiExecution
    }),
  )
  return { allocate, complete: completeTurn(capability), poll: pollTurn(capability), submit: submitTurn(capability) }
})

export class PiNodeEffects extends Context.Service<PiNodeEffects, Effect.Success<typeof makePiNodeEffects>>()(
  'flowdeck/PiNodeEffects',
) {}
