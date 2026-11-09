import { Machine } from '@typeonce/effect-machine'
import { Effect } from 'effect'

import { makeDefinition, taskResult } from '@/features/workflow/driver'
import { makeMachine, TaskEvents } from '@/features/workflow/machine'

import { demoVersion1 } from './input'
import { approvalTask, DemoContext, publishTask } from './node'

const states = Machine.state({
  states: {
    prepare: { annotations: { title: 'Prepare release', description: 'task' } },
    approval: { annotations: { title: 'Manual approval', description: 'checkpoint' } },
    publish: { annotations: { title: 'Publish release', description: 'task' } },
    completed: { type: 'final' },
  },
})
const native = Machine.make({
  root: states,
  events: TaskEvents,
  branches: {
    preparing: { prepared: { target: 'approval', title: 'prepared' } },
    approving: { resume: { target: 'publish', title: 'resume' } },
  },
}).handle({
  initial: { target: 'prepare' },
  states: {
    prepare: { on: { Done: { branches: 'preparing', resolve: ({ select }) => select.prepared() } } },
    approval: { on: { Done: { branches: 'approving', resolve: ({ select }) => select.resume() } } },
    publish: { on: { Done: { target: 'completed' } } },
    completed: {},
  },
})
const result = taskResult<DemoContext>()
export const demoVersion1Definition = makeDefinition({
  workflowId: 'demo',
  version: demoVersion1,
  machine: makeMachine({ graphId: 'demo-1_0_0-graph-1', native }),
  context: DemoContext,
  tasks: Effect.succeed({
    prepare: {
      execute: (context: DemoContext) =>
        Effect.succeed(result.Done({ context: { ...context, prepared: 'draft:v1' }, payload: { output: 'draft:v1' } })),
    },
    approval: approvalTask,
    publish: publishTask,
  }),
})
