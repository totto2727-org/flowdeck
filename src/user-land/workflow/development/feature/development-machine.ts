import { Machine } from '@typeonce/effect-machine'
import { Effect, Match, Predicate, Schema } from 'effect'

import { PiExecutionFields, PiNodeEffects, piExecutionData, piNodeEvent } from '@/core/feature/pi/node'
import type { PiExecution, PiResult } from '@/core/feature/pi/node'
import { ResumeEvent, WorkflowCheckpoint } from '@/core/feature/workflow/managed-runtime'
import type { EventDraft } from '@/core/feature/workflow/managed-runtime'

import { DevelopmentCreateRun, DevelopmentTask, DevelopmentWorkflowVersion, PublicRepository } from './input.ts'

const executionState = { fields: PiExecutionFields }
const resultState = { fields: { ...PiExecutionFields, result: Schema.String } }
const taskAnnotations = (title: string): Readonly<{ description: 'task'; title: string }> =>
  // Preserve the annotation order exposed by the native manifest.
  ({ title, description: 'task' })

export const DevelopmentStates = Machine.state({
  // These fields define the stored native root snapshot order.
  fields: {
    version: DevelopmentWorkflowVersion,
    runtime: Schema.Literal('pi-harness'),
    repository: PublicRepository,
    task: DevelopmentTask,
  },
  // The native graph iterates states in declaration order.
  states: {
    implement: {
      annotations: taskAnnotations('Implement task'),
      // Preserve the native implementation transition order.
      states: {
        allocate: {},
        intent: executionState,
        awaiting: executionState,
        polling: executionState,
        accepted: resultState,
      },
    },
    verify: {
      annotations: taskAnnotations('Verify and fix'),
      // Preserve the native verification transition order.
      states: {
        allocate: {},
        intent: executionState,
        awaiting: executionState,
        polling: executionState,
        completing: resultState,
      },
    },
    completed: { ...resultState, type: 'final' },
    failed: {
      // Preserve the stored terminal failure field order.
      fields: { ...PiExecutionFields, nodeId: Schema.Literals(['implement', 'verify']), message: Schema.String },
    },
  },
})
export const DevelopmentEvents = Machine.eventsFromSchemas(ResumeEvent)

const implementationPrompt = (state: Readonly<{ repository: URL; task: string }>): string =>
  `Use Pi to clone the public GitHub repository ${state.repository.href} into /workspace/project. Work only in this fixed project workspace. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Implement the following task. Do not push or deploy.\n\n${state.task}`
const verificationPrompt =
  'Continue with Pi in the same /workspace/project repository and session. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Run the project checks and tests, fix failures caused by the implementation, and report checks performed and remaining limitations. Do not push or deploy.'

type DevelopmentNode = 'implement' | 'verify'
type SubmitInput = Readonly<{ execution: PiExecution; nodeId: DevelopmentNode; prompt: string }>

const isFailed = Predicate.isTagged('Failed')

const failedState = (
  state: PiExecution,
  nodeId: DevelopmentNode,
  message: string,
): PiExecution & Readonly<{ message: string; nodeId: DevelopmentNode }> =>
  // Preserve the order of fields in the native failure state.
  ({ ...piExecutionData(state), nodeId, message })

const pi = {
  accept: (result: PiResult) =>
    Effect.gen(function* () {
      const checkpoint = yield* WorkflowCheckpoint
      yield* checkpoint.checkpoint([
        piNodeEvent({
          execution: result,
          nodeId: 'implement',
          payload: { output: result.result },
          type: 'node.succeeded',
        }),
      ])
    }),
  allocate: Effect.flatMap(PiNodeEffects, (effects) => effects.allocate),
  complete: (result: PiResult) => Effect.flatMap(PiNodeEffects, (effects) => effects.complete(result)),
  poll: (execution: PiExecution) => Effect.flatMap(PiNodeEffects, (effects) => effects.poll(execution)),
  submit: (input: SubmitInput) =>
    Effect.gen(function* () {
      const checkpoint = yield* WorkflowCheckpoint
      const effects = yield* PiNodeEffects
      yield* checkpoint.checkpoint([
        ...(input.nodeId === 'implement' ? [{ payload: {}, type: 'run.started' } satisfies EventDraft] : []),
        piNodeEvent({ execution: input.execution, nodeId: input.nodeId, type: 'node.started' }),
      ])
      return yield* effects.submit(input)
    }),
}

/** Concrete native topology owns every asynchronous operation and recovery edge.
 * The shared Pi effects contain no transition dispatcher or independent PiPhase. */
// oxlint-disable-next-line eslint/no-redeclare -- Keep the machine and its inferred type paired for callers.
export const DevelopmentMachine = Machine.make({
  // Keep native branch definitions in workflow execution order.
  branches: {
    implementationSubmission: {
      awaiting: { target: 'implement.awaiting' },
      failed: { target: 'failed' },
    },
    // The native manifest enumerates implementation receipt alternatives in this order.
    implementationReceipt: {
      running: { target: 'implement.awaiting' },
      'implementation complete': { target: 'implement.accepted' },
      failed: { target: 'failed' },
    },
    implementationAcceptance: { 'implementation complete': { target: 'verify' } },
    verificationSubmission: {
      awaiting: { target: 'verify.awaiting' },
      failed: { target: 'failed' },
    },
    // The native manifest enumerates verification receipt alternatives in this order.
    verificationReceipt: {
      running: { target: 'verify.awaiting' },
      completed: { target: 'verify.completing' },
      failed: { target: 'failed' },
    },
    completion: {
      completed: { target: 'completed' },
      failed: { target: 'failed' },
    },
  },
  effects: {
    accept: pi.accept,
    allocate: pi.allocate,
    complete: pi.complete,
    poll: pi.poll,
    submit: pi.submit,
  },
  events: DevelopmentEvents,
  id: 'jcode-development-1_0_0',
  input: DevelopmentCreateRun,
  root: DevelopmentStates,
}).handle({
  initial: { target: 'implement' },
  // Match the field order of the persisted development root state.
  root: ({ input }) => ({
    version: input.version,
    runtime: 'pi-harness',
    repository: input.repository,
    task: input.task,
  }),
  // Keep handlers aligned with the native state order in the graph.
  states: {
    implement: {
      initial: { target: 'implement.allocate' },
      // Keep the order of native implementation handlers.
      states: {
        allocate: { invoke: { onDone: { data: ({ output }) => output, target: 'implement.intent' }, src: 'allocate' } },
        intent: {
          invoke: {
            input: ({ state, root }) => ({ execution: state, nodeId: 'implement', prompt: implementationPrompt(root) }),
            onDone: {
              branches: 'implementationSubmission',
              resolve: ({ state, output, select }) =>
                isFailed(output)
                  ? select.failed({ data: failedState(state, 'implement', output.message) })
                  : select.awaiting({ data: piExecutionData(state) }),
            },
            src: 'submit',
          },
        },
        awaiting: { on: { Resume: { data: ({ state }) => piExecutionData(state), target: 'implement.polling' } } },
        polling: {
          invoke: {
            input: ({ state }) => state,
            onDone: {
              branches: 'implementationReceipt',
              resolve: ({ state, output, select }) => {
                const execution = piExecutionData(state)
                return Match.value(output).pipe(
                  Match.tagsExhaustive({
                    Completed: ({ result }) => select['implementation complete']({ data: { ...execution, result } }),
                    Failed: ({ message }) => {
                      const data = failedState(state, 'implement', message)
                      return select.failed({ data })
                    },
                    Waiting: () => select.running({ data: execution }),
                  }),
                )
              },
            },
            src: 'poll',
          },
        },
        accepted: {
          invoke: {
            input: ({ state }) => state,
            onDone: {
              branches: 'implementationAcceptance',
              resolve: ({ select }) => select['implementation complete'](),
            },
            src: 'accept',
          },
        },
      },
    },
    verify: {
      initial: { target: 'verify.allocate' },
      // Keep the order of native verification handlers.
      states: {
        allocate: { invoke: { onDone: { data: ({ output }) => output, target: 'verify.intent' }, src: 'allocate' } },
        intent: {
          invoke: {
            input: ({ state }) => ({ execution: state, nodeId: 'verify', prompt: verificationPrompt }),
            onDone: {
              branches: 'verificationSubmission',
              resolve: ({ state, output, select }) =>
                isFailed(output)
                  ? select.failed({ data: failedState(state, 'verify', output.message) })
                  : select.awaiting({ data: piExecutionData(state) }),
            },
            src: 'submit',
          },
        },
        awaiting: { on: { Resume: { data: ({ state }) => piExecutionData(state), target: 'verify.polling' } } },
        polling: {
          invoke: {
            input: ({ state }) => state,
            onDone: {
              branches: 'verificationReceipt',
              resolve: ({ state, output, select }) => {
                const execution = piExecutionData(state)
                return Match.value(output).pipe(
                  Match.tagsExhaustive({
                    Completed: ({ result }) => select.completed({ data: { ...execution, result } }),
                    Failed: ({ message }) => {
                      const data = failedState(state, 'verify', message)
                      return select.failed({ data })
                    },
                    Waiting: () => select.running({ data: execution }),
                  }),
                )
              },
            },
            src: 'poll',
          },
        },
        completing: {
          invoke: {
            input: ({ state }) => state,
            onDone: {
              branches: 'completion',
              resolve: ({ state, output, select }) =>
                isFailed(output)
                  ? select.failed({ data: failedState(state, 'verify', output.message) })
                  : select.completed({ data: { ...piExecutionData(state), result: state.result } }),
            },
            src: 'complete',
          },
        },
      },
    },
    completed: {},
    failed: {},
  },
})

export type DevelopmentMachine = typeof DevelopmentMachine
export type DevelopmentNativeState = Machine.Machine.Snapshot<Machine.Machine.States<DevelopmentMachine>>
