import { Machine } from '@typeonce/effect-machine'
import { Effect, Schema } from 'effect'

import { ResumeEvent } from '@/features/workflow/managed-runtime'

import { DevelopmentCreateRun, DevelopmentTask, DevelopmentWorkflowVersion, PublicRepository } from './input'
import { PiExecutionFields, PiNodeEffects, piExecutionData } from './pi-node'

const execution = { fields: PiExecutionFields }
const result = { fields: { ...PiExecutionFields, result: Schema.String } }
export const DevelopmentStates = Machine.state({
  fields: {
    version: DevelopmentWorkflowVersion,
    runtime: Schema.Literal('pi-harness'),
    repository: PublicRepository,
    task: DevelopmentTask,
  },
  states: {
    implement: {
      annotations: { title: 'Implement task', description: 'task' },
      states: { allocate: {}, intent: execution, awaiting: execution, polling: execution, accepted: result },
    },
    verify: {
      annotations: { title: 'Verify and fix', description: 'task' },
      states: { allocate: {}, intent: execution, awaiting: execution, polling: execution, completing: result },
    },
    completed: { ...result, type: 'final' },
    failed: {
      fields: { ...PiExecutionFields, nodeId: Schema.Literals(['implement', 'verify']), message: Schema.String },
    },
  },
})
export const DevelopmentEvents = Machine.eventsFromSchemas(ResumeEvent)

const implementationPrompt = (state: { readonly repository: URL; readonly task: string }) =>
  `Use Pi to clone the public GitHub repository ${state.repository.href} into /workspace/project. Work only in this fixed project workspace. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Implement the following task. Do not push or deploy.\n\n${state.task}`
const verificationPrompt =
  'Continue with Pi in the same /workspace/project repository and session. Follow the target repository instructions. Use the official Vite+ CLI for JavaScript runtimes, package managers, dependencies, and tasks. Install it with the official installer if it is missing. Let vp env resolve the target project versions. Use nix develop or a minimal temporary nix shell only for non-JavaScript tools. Run the project checks and tests, fix failures caused by the implementation, and report checks performed and remaining limitations. Do not push or deploy.'

const pi = {
  allocate: Effect.flatMap(PiNodeEffects, (effects) => effects.allocate),
  submit: (input: Parameters<typeof PiNodeEffects.Service.submit>[0]) =>
    Effect.flatMap(PiNodeEffects, (effects) => effects.submit(input)),
  poll: (execution: Parameters<typeof PiNodeEffects.Service.poll>[0]) =>
    Effect.flatMap(PiNodeEffects, (effects) => effects.poll(execution)),
  accept: (result: Parameters<typeof PiNodeEffects.Service.accept>[0]) =>
    Effect.flatMap(PiNodeEffects, (effects) => effects.accept(result)),
  complete: (result: Parameters<typeof PiNodeEffects.Service.complete>[0]) =>
    Effect.flatMap(PiNodeEffects, (effects) => effects.complete(result)),
}

/** Concrete native topology owns every asynchronous operation and recovery edge.
 * The shared Pi effects contain no transition dispatcher or independent PiPhase. */
export const DevelopmentMachine = Machine.make({
  id: 'jcode-development-1_0_0',
  root: DevelopmentStates,
  input: DevelopmentCreateRun,
  events: DevelopmentEvents,
  effects: {
    allocate: pi.allocate,
    submit: pi.submit,
    poll: pi.poll,
    accept: pi.accept,
    complete: pi.complete,
  },
  branches: {
    implementationSubmission: {
      awaiting: { target: 'implement.awaiting' },
      failed: { target: 'failed' },
    },
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
}).handle({
  root: ({ input }) => ({
    version: input.version,
    runtime: 'pi-harness',
    repository: input.repository,
    task: input.task,
  }),
  initial: { target: 'implement' },
  states: {
    implement: {
      initial: { target: 'implement.allocate' },
      states: {
        allocate: { invoke: { src: 'allocate', onDone: { target: 'implement.intent', data: ({ output }) => output } } },
        intent: {
          invoke: {
            src: 'submit',
            input: ({ state, root }) => ({ nodeId: 'implement', execution: state, prompt: implementationPrompt(root) }),
            onDone: {
              branches: 'implementationSubmission',
              resolve: ({ state, output, select }) =>
                output._tag === 'Failed'
                  ? select.failed({ data: { ...piExecutionData(state), nodeId: 'implement', message: output.message } })
                  : select.awaiting({ data: piExecutionData(state) }),
            },
          },
        },
        awaiting: { on: { Resume: { target: 'implement.polling', data: ({ state }) => piExecutionData(state) } } },
        polling: {
          invoke: {
            src: 'poll',
            input: ({ state }) => state,
            onDone: {
              branches: 'implementationReceipt',
              resolve: ({ state, output, select }) => {
                if (output._tag === 'Waiting') return select.running({ data: piExecutionData(state) })
                if (output._tag === 'Completed')
                  return select['implementation complete']({
                    data: { ...piExecutionData(state), result: output.result },
                  })
                return select.failed({
                  data: { ...piExecutionData(state), nodeId: 'implement', message: output.message },
                })
              },
            },
          },
        },
        accepted: {
          invoke: {
            src: 'accept',
            input: ({ state }) => state,
            onDone: {
              branches: 'implementationAcceptance',
              resolve: ({ select }) => select['implementation complete'](),
            },
          },
        },
      },
    },
    verify: {
      initial: { target: 'verify.allocate' },
      states: {
        allocate: { invoke: { src: 'allocate', onDone: { target: 'verify.intent', data: ({ output }) => output } } },
        intent: {
          invoke: {
            src: 'submit',
            input: ({ state }) => ({ nodeId: 'verify', execution: state, prompt: verificationPrompt }),
            onDone: {
              branches: 'verificationSubmission',
              resolve: ({ state, output, select }) =>
                output._tag === 'Failed'
                  ? select.failed({ data: { ...piExecutionData(state), nodeId: 'verify', message: output.message } })
                  : select.awaiting({ data: piExecutionData(state) }),
            },
          },
        },
        awaiting: { on: { Resume: { target: 'verify.polling', data: ({ state }) => piExecutionData(state) } } },
        polling: {
          invoke: {
            src: 'poll',
            input: ({ state }) => state,
            onDone: {
              branches: 'verificationReceipt',
              resolve: ({ state, output, select }) => {
                if (output._tag === 'Waiting') return select.running({ data: piExecutionData(state) })
                if (output._tag === 'Completed')
                  return select.completed({ data: { ...piExecutionData(state), result: output.result } })
                return select.failed({ data: { ...piExecutionData(state), nodeId: 'verify', message: output.message } })
              },
            },
          },
        },
        completing: {
          invoke: {
            src: 'complete',
            input: ({ state }) => state,
            onDone: {
              branches: 'completion',
              resolve: ({ state, output, select }) =>
                output._tag === 'Failed'
                  ? select.failed({ data: { ...piExecutionData(state), nodeId: 'verify', message: output.message } })
                  : select.completed({ data: { ...piExecutionData(state), result: state.result } }),
            },
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
