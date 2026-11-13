import { Context, Data, Effect, Schema } from 'effect'

import { makeExecutionIdGenerator, ExecutionId } from '@/features/workflow/domain/identity'
import { WorkflowCheckpoint, type EventDraft } from '@/features/workflow/managed-runtime'
import { ResourceStore } from '@/features/workflow/resource-store'

import { CommandId, makeCommandIdGenerator } from './model'
import type { TurnReceipt } from './model'
import { DevelopmentSandbox } from './sandbox'

export const PiExecutionFields = {
  executionId: ExecutionId,
  commandId: CommandId,
  attempt: Schema.Literal(1),
}
export const PiExecution = Schema.Struct(PiExecutionFields)
export type PiExecution = typeof PiExecution.Type
export const piExecutionData = (execution: PiExecution): PiExecution => ({
  executionId: execution.executionId,
  commandId: execution.commandId,
  attempt: execution.attempt,
})
export type PiNodeId = 'implement' | 'verify'
export const PiResult = Schema.Struct({ ...PiExecutionFields, result: Schema.String })
export type PiResult = typeof PiResult.Type
export type PiOutcome = Data.TaggedEnum<{
  Waiting: {}
  Completed: { readonly result: string }
  Failed: { readonly message: string }
}>
const outcome = Data.taggedEnum<PiOutcome>()

export const piNodeEvent = (
  nodeId: PiNodeId,
  execution: PiExecution,
  type: 'node.started' | 'node.succeeded' | 'node.failed' | 'run.waiting',
  payload: EventDraft['payload'] = {},
): EventDraft => ({
  type,
  nodeId,
  executionId: execution.executionId,
  attempt: execution.attempt,
  payload,
})

const receiptOutcome = (receipt: TurnReceipt, commandId: CommandId): PiOutcome => {
  if (receipt.commandId !== commandId)
    return outcome.Failed({ message: 'Gateway returned a different command identity' })
  if (receipt.status === 'running') return outcome.Waiting()
  if (receipt.status === 'completed') return outcome.Completed({ result: receipt.text })
  return outcome.Failed({ message: receipt.error })
}

/** Reusable turn effects, not a phase interpreter. The owning native states choose
 * initialization, submission, polling, acceptance and final completion separately. */
export const makePiNodeEffects = Effect.gen(function* () {
  const sandbox = yield* DevelopmentSandbox
  const executionId = yield* makeExecutionIdGenerator
  const commandId = yield* makeCommandIdGenerator

  // The DO owns the actual Harness. Cache only its capability handle in this
  // request's volatile resource scope, never a conversation or serialized client.
  const capability = Effect.flatMap(ResourceStore, (resources) =>
    resources.getOrTryInit(DevelopmentSandbox, Effect.succeed(sandbox)),
  )
  const allocate = Effect.gen(function* () {
    const checkpoint = yield* WorkflowCheckpoint
    return yield* Effect.gen(function* () {
      return { executionId: yield* executionId(), commandId: yield* commandId(), attempt: 1 } satisfies PiExecution
    }).pipe(Effect.catch(checkpoint.fail))
  })

  const submit = (input: { readonly nodeId: PiNodeId; readonly execution: PiExecution; readonly prompt: string }) =>
    Effect.gen(function* () {
      const checkpoint = yield* WorkflowCheckpoint
      yield* checkpoint.checkpoint([
        ...(input.nodeId === 'implement' ? [{ type: 'run.started', payload: {} } satisfies EventDraft] : []),
        piNodeEvent(input.nodeId, input.execution, 'node.started'),
      ])
      return yield* Effect.gen(function* () {
        const provider = yield* capability
        const session = yield* provider.ensureSession(checkpoint.runId)
        if (session.status !== 'active')
          return outcome.Failed({
            message: 'The original active Pi session is unavailable. Container retained for inspection.',
          })
        // Only authoritative absence of an unacknowledged intent permits this
        // exact operation to be submitted. Awaiting polls never use this path.
        const existing = yield* provider.getTurn(checkpoint.runId, input.execution.commandId)
        const receipt =
          existing ??
          (yield* provider.submitTurn(checkpoint.runId, {
            commandId: input.execution.commandId,
            prompt: input.prompt,
          }))
        const result = receiptOutcome(receipt, input.execution.commandId)
        return result._tag === 'Failed' ? result : outcome.Waiting()
      }).pipe(Effect.catch(checkpoint.fail))
    })

  const poll = (execution: PiExecution) =>
    Effect.gen(function* () {
      const checkpoint = yield* WorkflowCheckpoint
      return yield* Effect.gen(function* () {
        const provider = yield* capability
        // Explicit Resume is read-only while the Harness operation is running.
        const receipt = yield* provider.getTurn(checkpoint.runId, execution.commandId)
        return receipt === null
          ? outcome.Failed({ message: 'A submitted turn is missing. It will not be resubmitted automatically.' })
          : receiptOutcome(receipt, execution.commandId)
      }).pipe(Effect.catch(checkpoint.fail))
    })

  const accept = (result: PiResult) =>
    Effect.gen(function* () {
      const checkpoint = yield* WorkflowCheckpoint
      yield* checkpoint.checkpoint([piNodeEvent('implement', result, 'node.succeeded', { output: result.result })])
    })

  const complete = (result: PiResult) =>
    Effect.gen(function* () {
      const checkpoint = yield* WorkflowCheckpoint
      // Keep result + command/execution identity durable before completion ACK.
      // A failed terminal D1 commit resumes here without another Pi turn.
      yield* checkpoint.checkpoint([])
      return yield* Effect.gen(function* () {
        const provider = yield* capability
        const original = yield* provider.ensureSession(checkpoint.runId)
        if (original.sessionId !== '1')
          return outcome.Failed({ message: 'The original Pi session is unavailable for completion' })
        const session = yield* provider.complete(checkpoint.runId)
        return session.sessionId === '1' && session.status === 'completed'
          ? outcome.Completed({ result: result.result })
          : outcome.Failed({ message: 'Could not complete the original Pi session' })
      }).pipe(Effect.catch(checkpoint.fail))
    })

  return { allocate, submit, poll, accept, complete }
})

export class PiNodeEffects extends Context.Service<PiNodeEffects, Effect.Success<typeof makePiNodeEffects>>()(
  'flowdeck/PiNodeEffects',
) {}
