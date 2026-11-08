import { Machine } from '@typeonce/effect-machine'
import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { makeMachine, TaskEvents } from './machine'

const states = Machine.state({
  states: {
    review: { annotations: { title: 'Review', description: 'task' } },
    accepted: { annotations: { title: 'Accepted', description: 'task' } },
    rejected: { annotations: { title: 'Rejected', description: 'task' } },
    completed: { type: 'final' },
  },
})
const native = Machine.make({
  root: states,
  events: TaskEvents,
  branches: {
    decide: { accept: { target: 'accepted', title: 'accepted' }, reject: { target: 'rejected', title: 'rejected' } },
  },
}).handle({
  initial: { target: 'review' },
  states: {
    review: {
      on: {
        Done: {
          branches: 'decide',
          resolve: ({ event, select }) => (event.context['accepted'] === true ? select.accept() : select.reject()),
        },
      },
    },
    accepted: { on: { Done: { target: 'completed' } } },
    rejected: { on: { Done: { target: 'completed' } } },
    completed: {},
  },
})
const machine = makeMachine({ graphId: 'review-graph', native })

describe('native Effect Machine adapter', () => {
  it('rejects distinct native branches sharing a source-target pair', () => {
    const duplicate = Machine.make({
      root: states,
      events: TaskEvents,
      branches: {
        decide: { first: { target: 'accepted' }, second: { target: 'accepted' } },
      },
    }).handle({
      initial: { target: 'review' },
      states: {
        review: { on: { Done: { branches: 'decide', resolve: ({ select }) => select.first() } } },
        accepted: {},
        rejected: {},
        completed: {},
      },
    })
    expect(() => makeMachine({ graphId: 'duplicate', native: duplicate })).toThrow('unique source-target pairs')
  })
  it('rejects native compound hierarchy', () => {
    const nested = Machine.make({
      root: Machine.state({ states: { parent: { states: { child: {} } } } }),
      events: TaskEvents,
    }).handle({
      initial: { target: 'parent' },
      states: { parent: { initial: { target: 'parent.child' }, states: { child: {} } } },
    })
    expect(() => makeMachine({ graphId: 'nested', native: nested })).toThrow('data-only flat machines')
  })
  it('rejects native parallel regions', () => {
    const parallel = Machine.make({
      root: Machine.state({
        states: {
          parent: {
            type: 'parallel',
            states: {
              left: { states: { child: {} } },
              right: { states: { child: {} } },
            },
          },
        },
      }),
      events: TaskEvents,
    }).handle({
      initial: { target: 'parent' },
      states: {
        parent: {
          states: {
            left: { initial: { target: 'parent.left.child' }, states: { child: {} } },
            right: { initial: { target: 'parent.right.child' }, states: { child: {} } },
          },
        },
      },
    })
    expect(() => makeMachine({ graphId: 'parallel', native: parallel })).toThrow('data-only flat machines')
  })
  it('rejects autonomous native transitions before tasks can be skipped', () => {
    const autonomous = Machine.make({ root: states, events: TaskEvents }).handle({
      initial: { target: 'review' },
      states: {
        review: { always: { target: 'accepted' } },
        accepted: {},
        rejected: {},
        completed: {},
      },
    })
    expect(() => makeMachine({ graphId: 'autonomous', native: autonomous })).toThrow('Done transitions')
  })
  it('rejects targetless native acceptance before a task can repeat indefinitely', () => {
    const targetless = Machine.make({ root: states, events: TaskEvents }).handle({
      initial: { target: 'review' },
      states: {
        review: { on: { Done: { none: true } } },
        accepted: {},
        rejected: {},
        completed: {},
      },
    })
    expect(() => makeMachine({ graphId: 'targetless', native: targetless })).toThrow('explicit state targets')
  })
  it('rejects native update-only branches with no topology target', () => {
    const values = Schema.TaggedUnion({ counter: { count: Schema.Number } })
    const updating = Machine.make({
      root: Machine.state({ states: { idle: {}, counter: values.cases.counter } }),
      events: TaskEvents,
    }).handle({
      initial: { target: 'idle' },
      states: {
        idle: { on: { Done: { target: 'counter', data: () => ({ count: 0 }) } } },
        counter: { on: { Done: { update: 'counter', data: ({ state }) => ({ count: state.count + 1 }) } } },
      },
    })
    expect(() => makeMachine({ graphId: 'updating', native: updating })).toThrow('explicit state targets')
  })
  it('derives every conditional edge from native branch declarations', () => {
    expect(machine.graph.edges).toEqual([
      { edgeId: 'review-accepted', source: 'review', target: 'accepted', label: 'accepted' },
      { edgeId: 'review-rejected', source: 'review', target: 'rejected', label: 'rejected' },
    ])
  })
  it.each([true, false])('uses the native resolver for accepted=%s after snapshot decode', async (accepted) => {
    const initial = await Effect.runPromise(machine.initial)
    const restored = await Effect.runPromise(machine.validate(initial.encoded))
    expect(restored).toEqual(initial)
    const next = await Effect.runPromise(machine.next(restored.encoded, { accepted }))
    expect(next.value).toBe(accepted ? 'accepted' : 'rejected')
    const completed = await Effect.runPromise(machine.next(next.encoded, {}))
    expect(completed).toMatchObject({ value: 'completed', completed: true })
  })
  it('rejects snapshots whose state paths are absent from the native topology', async () => {
    await expect(
      Effect.runPromise(
        machine.validate({
          _tag: 'MachineSnapshot',
          version: 2,
          active: [{ path: '' }, { path: 'missing' }],
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
  })
  it('rejects completion with no native transition rather than rerunning a task', async () => {
    const initial = await Effect.runPromise(machine.initial)
    const next = await Effect.runPromise(machine.next(initial.encoded, { accepted: true }))
    const completed = await Effect.runPromise(machine.next(next.encoded, {}))
    await expect(Effect.runPromise(machine.next(completed.encoded, {}))).rejects.toMatchObject({
      _tag: 'InvalidSnapshot',
    })
  })
})
