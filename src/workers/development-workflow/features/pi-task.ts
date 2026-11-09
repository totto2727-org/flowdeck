import { Effect, Match, Schema } from 'effect'

import { InvalidSnapshot } from '@/features/workflow/domain/errors'
import { TaskExecution, type Task, type TaskResult } from '@/features/workflow/driver'
import type { WorkflowFailure } from '@/features/workflow/services/failures'

import { DevelopmentTask, DevelopmentWorkflowVersion, PublicRepository } from './input'
import { CommandId, makeCommandIdGenerator, SessionId } from './model'
import { DevelopmentSandbox } from './sandbox'

/** Pi owns external-operation recovery data. The common machine owns graph position and node execution identity. */
export const PiPhase = Schema.Union([
  Schema.TaggedStruct('Ready', {}),
  Schema.TaggedStruct('Starting', { commandId: CommandId }),
  Schema.TaggedStruct('PendingTurn', { commandId: CommandId, sessionId: SessionId }),
  Schema.TaggedStruct('AwaitingTurn', { commandId: CommandId, sessionId: SessionId }),
  Schema.TaggedStruct('Completing', { commandId: CommandId, sessionId: SessionId, result: Schema.String }),
  Schema.TaggedStruct('TurnComplete', { sessionId: SessionId, result: Schema.String }),
]).pipe(Schema.toTaggedUnion('_tag'))
export type PiPhase = typeof PiPhase.Type

export const DevelopmentContext = Schema.Struct({
  version: DevelopmentWorkflowVersion,
  runtime: Schema.Literal('pi-harness'),
  repository: PublicRepository,
  task: DevelopmentTask,
  phase: PiPhase,
})
export type DevelopmentContext = typeof DevelopmentContext.Type
export const DevelopmentContextJson = Schema.toCodecJson(DevelopmentContext)

const implementationPrompt = (context: DevelopmentContext) =>
  `Use Pi to clone the public GitHub repository ${context.repository.href} into /workspace/project. Work only in this fixed project workspace. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Implement the following task. Do not push or deploy.\n\n${context.task}`
const verificationPrompt =
  'Continue with Pi in the same /workspace/project repository and session. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Run the project checks and tests, fix failures caused by the implementation, and report checks performed and remaining limitations. Do not push or deploy.'

type Control = typeof TaskExecution.Service
type Outcome = TaskResult<DevelopmentContext>
const failed = (context: DevelopmentContext, message: string): Outcome => ({
  _tag: 'Fail',
  context,
  message,
  payload: { message },
})
const done = (context: DevelopmentContext, sessionId: SessionId, result: string): Outcome => ({
  _tag: 'Done',
  context: { ...context, phase: PiPhase.cases.TurnComplete.make({ sessionId, result }) },
  payload: { output: result },
})

/** Stable sandbox and Crypto dependencies are acquired once by the executor's runtime root. */
export const makePiTasks = Effect.gen(function* () {
  const sandbox = yield* DevelopmentSandbox
  const commandId = yield* makeCommandIdGenerator

  const complete = (context: DevelopmentContext, phase: Extract<PiPhase, { _tag: 'Completing' }>, control: Control) =>
    Effect.gen(function* () {
      const original = yield* sandbox.ensureSession(control.runId)
      if (original.sessionId !== phase.sessionId)
        return failed(context, 'The original Pi session is unavailable for completion')
      const session = yield* sandbox.complete(control.runId)
      if (session.sessionId !== phase.sessionId || session.status !== 'completed')
        return failed(context, 'Could not complete the original Pi session')
      // Completion acknowledges Pi work. It never destroys the Container or workspace.
      return done(context, phase.sessionId, phase.result)
    })

  const submit = (
    context: DevelopmentContext,
    phase: Extract<PiPhase, { _tag: 'PendingTurn' }>,
    control: Control,
    prompt: string,
  ) =>
    Effect.gen(function* () {
      const session = yield* sandbox.ensureSession(control.runId)
      if (session.sessionId !== phase.sessionId || session.status !== 'active')
        return failed(context, 'The original active Pi session is unavailable. Container retained for inspection.')
      // Only authoritative absence while the intent is unacknowledged permits submitting this exact command again.
      const existing = yield* sandbox.getTurn(control.runId, phase.commandId)
      const receipt = existing ?? (yield* sandbox.submitTurn(control.runId, { commandId: phase.commandId, prompt }))
      if (receipt.commandId !== phase.commandId) return failed(context, 'Gateway returned a different command identity')
      if (receipt.status === 'failed' || receipt.status === 'interrupted') return failed(context, receipt.error)
      return {
        _tag: 'Wait',
        context: {
          ...context,
          phase: PiPhase.cases.AwaitingTurn.make({ commandId: phase.commandId, sessionId: phase.sessionId }),
        },
      } satisfies Outcome
    })

  const begin = (
    context: DevelopmentContext,
    phase: Extract<PiPhase, { _tag: 'Starting' }>,
    control: Control,
    prompt: string,
  ) =>
    Effect.gen(function* () {
      const session = yield* sandbox.ensureSession(control.runId)
      if (session.status !== 'active') return failed(context, 'Pi session is already complete')
      const pending = PiPhase.cases.PendingTurn.make({ commandId: phase.commandId, sessionId: session.sessionId })
      const next = { ...context, phase: pending }
      yield* control.checkpoint(next)
      return yield* submit(next, pending, control, prompt)
    })

  const poll = (
    context: DevelopmentContext,
    phase: Extract<PiPhase, { _tag: 'AwaitingTurn' }>,
    control: Control,
    finishSession: boolean,
  ) =>
    Effect.gen(function* () {
      const receipt = yield* sandbox.getTurn(control.runId, phase.commandId)
      if (receipt === null)
        return failed(context, 'A submitted turn is missing. It will not be resubmitted automatically.')
      if (receipt.commandId !== phase.commandId) return failed(context, 'Gateway returned a different command identity')
      if (receipt.status === 'running') return { _tag: 'Unchanged' } satisfies Outcome
      if (receipt.status !== 'completed') return failed(context, receipt.error)
      if (!finishSession) return done(context, phase.sessionId, receipt.text)
      const completing = PiPhase.cases.Completing.make({
        commandId: phase.commandId,
        sessionId: phase.sessionId,
        result: receipt.text,
      })
      const next = { ...context, phase: completing }
      // This intent survives completion ACK uncertainty and the final D1 checkpoint failing.
      yield* control.checkpoint(next)
      return yield* complete(next, completing, control)
    })

  const implement: Task<DevelopmentContext> = {
    execute: (context): Effect.Effect<Outcome, WorkflowFailure, TaskExecution> =>
      Effect.gen(function* () {
        const control = yield* TaskExecution
        return yield* Match.value(context.phase).pipe(
          Match.tag('Ready', () =>
            Effect.gen(function* () {
              const starting = PiPhase.cases.Starting.make({ commandId: yield* commandId() })
              const next = { ...context, phase: starting }
              yield* control.checkpoint(next)
              return yield* begin(next, starting, control, implementationPrompt(context))
            }),
          ),
          Match.tag('Starting', (phase) => begin(context, phase, control, implementationPrompt(context))),
          Match.tag('PendingTurn', (phase) => submit(context, phase, control, implementationPrompt(context))),
          Match.tag('AwaitingTurn', (phase) => poll(context, phase, control, false)),
          Match.tag('Completing', 'TurnComplete', () =>
            Effect.fail(new InvalidSnapshot({ message: 'Invalid implementation recovery phase' })),
          ),
          Match.exhaustive,
        )
      }),
  }
  const verify: Task<DevelopmentContext> = {
    execute: (context): Effect.Effect<Outcome, WorkflowFailure, TaskExecution> =>
      Effect.gen(function* () {
        const control = yield* TaskExecution
        return yield* Match.value(context.phase).pipe(
          Match.tag('TurnComplete', (phase) =>
            Effect.gen(function* () {
              const pending = PiPhase.cases.PendingTurn.make({
                commandId: yield* commandId(),
                sessionId: phase.sessionId,
              })
              const next = { ...context, phase: pending }
              yield* control.checkpoint(next)
              return yield* submit(next, pending, control, verificationPrompt)
            }),
          ),
          Match.tag('PendingTurn', (phase) => submit(context, phase, control, verificationPrompt)),
          Match.tag('AwaitingTurn', (phase) => poll(context, phase, control, true)),
          Match.tag('Completing', (phase) => complete(context, phase, control)),
          Match.tag('Ready', 'Starting', () =>
            Effect.fail(new InvalidSnapshot({ message: 'Invalid verification recovery phase' })),
          ),
          Match.exhaustive,
        )
      }),
  }
  return { implement, verify }
})
