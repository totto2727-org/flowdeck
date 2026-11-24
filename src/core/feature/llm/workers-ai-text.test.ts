import { live } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { AIBinding, WorkerEnvironment, WorkersAIError } from 'alchemy/Cloudflare/Workers'
import { makeWorkerRuntimeContext } from 'alchemy/Cloudflare/Workers/WorkerRuntimeContext'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Context, Data, Deferred, Effect, Exit, Fiber, Schema } from 'effect'
import { describe, expect, expectTypeOf, vi } from 'vite-plus/test'

import { makeWorkersAiText, WorkersAiText, WorkersAiTextModelSchema, workersAiTextModel } from './workers-ai-text.ts'

type Inference = (model: string, inputs: unknown, options?: unknown) => Promise<unknown>
type Review = (text: string) => void

const ReviewObserver = Context.Service<Review>('flowdeck/test/ReviewObserver')
class InferenceFailure extends Data.TaggedError('InferenceFailure')<{ message: string }> {}

const makeText = (run: Inference): Effect.Effect<WorkersAiText['Service']> => {
  const runtime = makeWorkerRuntimeContext('synthetic-ai')
  return makeWorkersAiText.pipe(
    Effect.provide(AIBinding),
    Effect.provideService(WorkerEnvironment, { AI: { run } }),
    Effect.provideService(RuntimeContext, runtime),
  )
}

const states = Machine.state({
  states: {
    completed: { type: 'final' },
    failed: { type: 'final' },
    generate: {},
    review: Schema.TaggedStruct('review', { text: Schema.String }),
  },
})
const machine = Machine.make({
  effects: {
    generate: Effect.gen(function* () {
      const text = yield* WorkersAiText
      return yield* text.generate({ prompt: 'Summarize the run' })
    }),
    review: (text: string) =>
      Effect.gen(function* () {
        const notify = yield* ReviewObserver
        notify(text)
      }),
  },
  events: Machine.events({}),
  id: 'workers-ai-text-test',
  root: states,
}).handle({
  initial: { target: 'generate' },
  states: {
    completed: {},
    failed: {},
    generate: {
      invoke: {
        onDone: { data: ({ output }) => ({ text: output }), target: 'review' },
        onFailure: { target: 'failed' },
        src: 'generate',
      },
    },
    review: { invoke: { input: ({ state }) => state.text, onDone: { target: 'completed' }, src: 'review' } },
  },
})

const stoppedText: WorkersAiText['Service'] = { generate: () => Effect.never }
const runMachine = Effect.fn(function* (text: WorkersAiText['Service'], review: Review) {
  const run = Effect.gen(function* () {
    const ref = yield* Machine.start(machine)
    yield* ref.join
    return yield* ref.state
  })
  return yield* run.pipe(
    Effect.scoped,
    Effect.provideService(WorkersAiText, text),
    Effect.provideService(ReviewObserver, review),
    Effect.timeout('2 seconds'),
  )
})

describe('workers AI model selection', () => {
  live.each(WorkersAiTextModelSchema.literals)('runs the caller-selected compatible model %s', (model) =>
    Effect.gen(function* () {
      const run = vi.fn<Inference>().mockResolvedValue({ response: 'selected model output' })
      const text = yield* makeText(run)
      const output = yield* text.generate({ max_tokens: 20, prompt: 'Write' }, model)
      expect(output).toBe('selected model output')
      expect(run.mock.calls).toStrictEqual([[model, { max_tokens: 20, prompt: 'Write', stream: false }, undefined]])
    }),
  )

  live('uses the native model contract, forces nonstreaming and returns generated text', () =>
    Effect.gen(function* () {
      const run = vi.fn<Inference>().mockResolvedValue({ response: 'A concise summary' })
      const text = yield* makeText(run)
      const result = text.generate({ max_tokens: 40, prompt: 'Summarize', temperature: 0.2 })
      expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<never>()
      expect(yield* result).toBe('A concise summary')
      expect(run.mock.calls).toStrictEqual([
        [workersAiTextModel, { max_tokens: 40, prompt: 'Summarize', stream: false, temperature: 0.2 }, undefined],
      ])
    }),
  )

  live('accepts the native string output alternative', () =>
    Effect.gen(function* () {
      const text = yield* makeText(vi.fn<Inference>().mockResolvedValue('Plain generated text'))
      expect(yield* text.generate({ prompt: 'Write' })).toBe('Plain generated text')
    }),
  )
})

describe('workers AI failure handling and runtime capture', () => {
  live.each([
    { name: 'async receipts', output: { request_id: 'pending' } },
    { name: 'tool-only responses', output: { tool_calls: [] } },
    { name: 'nontext responses', output: { response: 42 } },
  ])('rejects $name instead of treating them as completed text', ({ output }) =>
    Effect.gen(function* () {
      const text = yield* makeText(vi.fn<Inference>().mockResolvedValue(output))
      const result = text.generate({ prompt: 'Write' })
      expect(Schema.isSchemaError(yield* Effect.flip(result))).toBe(true)
    }),
  )

  live('retains the original native inference error as the WorkersAIError cause', () =>
    Effect.gen(function* () {
      const cause = new InferenceFailure({ message: 'synthetic binding failure' })
      const text = yield* makeText(vi.fn<Inference>().mockRejectedValue(cause))
      const error = yield* Effect.flip(text.generate({ prompt: 'Write' }))
      expect(error).toBeInstanceOf(WorkersAIError)
      expect(error).toHaveProperty('cause', cause)
    }),
  )

  live('does not let a caller replace the captured native binding', () =>
    Effect.gen(function* () {
      const text = yield* makeText(vi.fn<Inference>().mockResolvedValue({ response: 'original' }))
      const unexpected = vi.fn<Inference>().mockResolvedValue({ response: 'replacement' })
      const runtime = makeWorkerRuntimeContext('replacement')
      const result = yield* text
        .generate({ prompt: 'Write' })
        .pipe(
          Effect.provideService(WorkerEnvironment, { AI: { run: unexpected } }),
          Effect.provideService(RuntimeContext, runtime),
        )
      expect(result).toBe('original')
      expect(unexpected).not.toHaveBeenCalled()
    }),
  )
})

describe('workers AI interruption', () => {
  live('preserves interruption while inference is pending', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<true>()
      const { promise } = Promise.withResolvers<never>()
      const run = vi.fn<Inference>().mockImplementation(async () => {
        Deferred.doneUnsafe(started, Effect.succeed(true))
        return promise
      })
      const text = yield* makeText(run)
      const fiber = yield* Effect.forkChild(text.generate({ prompt: 'Write' }))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    }),
  )
})

describe('machine invocation of workers AI', () => {
  live('ordinary Machine.start automatically invokes generation and the next node', () =>
    Effect.gen(function* () {
      const text = yield* makeText(vi.fn<Inference>().mockResolvedValue({ response: 'generated' }))
      const review = vi.fn<Review>()
      const state = yield* runMachine(text, review)
      expect(states.matches(state, 'completed')).toBe(true)
      expect(review).toHaveBeenCalledExactlyOnceWith('generated')
    }),
  )

  live('ordinary Machine.invoke routes a typed inference failure without invoking the success node', () =>
    Effect.gen(function* () {
      const cause = new InferenceFailure({ message: 'synthetic failure' })
      const text = yield* makeText(vi.fn<Inference>().mockRejectedValue(cause))
      const review = vi.fn<Review>()
      const state = yield* runMachine(text, review)
      expect(states.matches(state, 'failed')).toBe(true)
      expect(review).not.toHaveBeenCalled()
    }),
  )

  live('ordinary Machine.resume reacquires a new text service and progresses from the saved invoke state', () =>
    Effect.gen(function* () {
      const snapshot = yield* Machine.start(machine).pipe(
        Effect.flatMap((ref) => ref.state),
        Effect.scoped,
        Effect.provideService(WorkersAiText, stoppedText),
        Effect.provideService(ReviewObserver, vi.fn<Review>()),
      )
      const text = yield* makeText(vi.fn<Inference>().mockResolvedValue({ response: 'resumed' }))
      const review = vi.fn<Review>()
      const resume = Effect.gen(function* () {
        const ref = yield* Machine.resume(machine, snapshot)
        yield* ref.join
        return yield* ref.state
      })
      const state = yield* resume.pipe(
        Effect.scoped,
        Effect.provideService(WorkersAiText, text),
        Effect.provideService(ReviewObserver, review),
        Effect.timeout('2 seconds'),
      )
      expect(states.matches(state, 'completed')).toBe(true)
      expect(review).toHaveBeenCalledExactlyOnceWith('resumed')
    }),
  )
})
