import { Machine } from '@typeonce/effect-machine'

import { TaskEvents } from '@/features/workflow/machine'

/** One native topology is the source for planning and the persisted visual graph. */
export const DevelopmentStates = Machine.state({
  states: {
    implement: { annotations: { title: 'Implement task', description: 'task' } },
    verify: { annotations: { title: 'Verify and fix', description: 'task' } },
    completed: { type: 'final' },
  },
})
export const DevelopmentEvents = TaskEvents
export const DevelopmentMachine = Machine.make({
  id: 'jcode-development-1_0_0',
  root: DevelopmentStates,
  events: DevelopmentEvents,
  branches: { implementation: { 'implementation complete': { target: 'verify' } } },
}).handle({
  initial: { target: 'implement' },
  states: {
    implement: {
      on: { Done: { branches: 'implementation', resolve: ({ select }) => select['implementation complete']() } },
    },
    verify: { on: { Done: { target: 'completed' } } },
    completed: {},
  },
})
