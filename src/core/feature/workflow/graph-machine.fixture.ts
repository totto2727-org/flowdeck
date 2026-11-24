import { Machine } from '@typeonce/effect-machine'
import { Effect, Schema } from 'effect'

const implementation = Machine.state({
  states: {
    completed: { type: 'final' },
    implement: {
      annotations: { description: 'task', title: 'Implement task' },
      states: { accepted: { type: 'final' }, submit: {} },
    },
    verify: { annotations: { description: 'task', title: 'Verify task' } },
  },
})

type Execute = (phase: string) => void

export const executableGraph = Effect.fn('flowdeck.test.prepareExecutableGraph')((execute: Execute) =>
  Effect.sync(() =>
    Machine.make({
      branches: { handoff: { verify: { target: 'verify', title: 'implementation complete' } } },
      effects: {
        implement: Effect.sync(() => {
          execute('implement')
        }),
        verify: Effect.sync(() => {
          execute('verify')
        }),
      },
      events: Machine.events({}),
      id: 'executable-graph',
      root: implementation,
    }).handle({
      initial: { target: 'implement' },
      states: {
        completed: {},
        implement: {
          initial: { target: 'implement.submit' },
          onDone: { branches: 'handoff', resolve: ({ select }) => select.verify() },
          states: {
            accepted: {},
            submit: { invoke: { onDone: { target: 'implement.accepted' }, src: 'implement' } },
          },
        },
        verify: { invoke: { onDone: { target: 'completed' }, src: 'verify' } },
      },
    }),
  ),
)

const allocation = Machine.state({
  states: {
    allocate: {},
    approval: { annotations: { description: 'checkpoint', title: 'Approval' } },
    completed: { type: 'final' },
    publish: { annotations: { description: 'task', title: 'Publish' } },
  },
})

export const allocationGraph = Effect.fn('flowdeck.test.prepareAllocationGraph')((allocate: () => void) =>
  Effect.sync(() =>
    Machine.make({
      effects: { allocate: Effect.sync(allocate), publish: Effect.void },
      events: Machine.events({ Resume: {} }),
      root: allocation,
    }).handle({
      initial: { target: 'approval' },
      states: {
        allocate: { invoke: { onDone: { target: 'publish' }, src: 'allocate' } },
        approval: { on: { Resume: { target: 'allocate' } } },
        completed: {},
        publish: { invoke: { onDone: { target: 'completed' }, src: 'publish' } },
      },
    }),
  ),
)

export const resume = Schema.TaggedStruct('Resume', {}).make({})

const alternatives = Machine.state({
  states: {
    approval: { annotations: { description: 'checkpoint', title: 'Approval' } },
    completed: { type: 'final' },
    publish: { annotations: { description: 'task', title: 'Publish' } },
  },
})

export const alternativeGraph = Machine.make({
  events: Machine.events({ Approve: {}, Resume: {} }),
  root: alternatives,
}).handle({
  initial: { target: 'approval' },
  states: {
    approval: {
      // oxlint-disable-next-line eslint/sort-keys -- Native transition order determines the projected combined edge label.
      on: { Resume: { target: 'publish' }, Approve: { target: 'publish' } },
    },
    completed: {},
    publish: {},
  },
})
