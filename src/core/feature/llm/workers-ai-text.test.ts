import { Machine } from '@typeonce/effect-machine'
import { AIBinding, WorkerEnvironment, WorkersAIError } from 'alchemy/Cloudflare/Workers'
import { makeWorkerRuntimeContext } from 'alchemy/Cloudflare/Workers/WorkerRuntimeContext'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Deferred, Effect, Exit, Fiber, Result, Schema } from 'effect'
import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'

import { makeWorkersAiText, WorkersAiText, WorkersAiTextModel, workersAiTextModel } from './workers-ai-text'

// Only inference is synthetic. Alchemy's actual AIBinding and native Machine runtime execute below.
const makeText = (run: (model: string, inputs: unknown) => Promise<unknown>) =>
  Effect.runPromise(
    makeWorkersAiText.pipe(
      Effect.provide(AIBinding),
      Effect.provideService(WorkerEnvironment, { AI: { run } }),
      Effect.provideService(RuntimeContext, makeWorkerRuntimeContext('synthetic-ai')),
    ),
  )

const states = Machine.state({
  states: {
    generate: {},
    review: Schema.TaggedStruct('review', { text: Schema.String }),
    completed: { type: 'final' },
    failed: { type: 'final' },
  },
})
const makeMachine = (review: (text: string) => void) =>
  Machine.make({
    id: 'workers-ai-text-test',
    root: states,
    events: Machine.events({}),
    effects: {
      generate: Effect.gen(function* () {
        return yield* (yield* WorkersAiText).generate({ prompt: 'Summarize the run' })
      }),
      review: (text: string) => Effect.sync(() => review(text)),
    },
  }).handle({
    initial: { target: 'generate' },
    states: {
      generate: {
        invoke: {
          src: 'generate',
          onDone: { target: 'review', data: ({ output }) => ({ text: output }) },
          onFailure: { target: 'failed' },
        },
      },
      review: { invoke: { src: 'review', input: ({ state }) => state.text, onDone: { target: 'completed' } } },
      completed: {},
      failed: {},
    },
  })

describe('Workers AI text (synthetic inference)', () => {
  it.each(WorkersAiTextModel.literals)('runs the caller-selected compatible model %s', async (model) => {
    const run = vi.fn(async () => ({ response: 'selected model output' }))
    const text = await makeText(run)
    expect(await Effect.runPromise(text.generate({ prompt: 'Write', max_tokens: 20 }, model))).toBe(
      'selected model output',
    )
    expect(run).toHaveBeenCalledExactlyOnceWith(model, { prompt: 'Write', max_tokens: 20, stream: false }, undefined)
  })

  it('uses the native model contract, forces nonstreaming and returns generated text', async () => {
    const run = vi.fn(async () => ({ response: 'A concise summary' }))
    const text = await makeText(run)
    const result = text.generate({ prompt: 'Summarize', max_tokens: 40, temperature: 0.2 })
    expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<never>()
    expect(await Effect.runPromise(result)).toBe('A concise summary')
    expect(run).toHaveBeenCalledExactlyOnceWith(
      workersAiTextModel,
      {
        prompt: 'Summarize',
        max_tokens: 40,
        temperature: 0.2,
        stream: false,
      },
      undefined,
    )
  })

  it('accepts the native string output alternative', async () => {
    const text = await makeText(async () => 'Plain generated text')
    expect(await Effect.runPromise(text.generate({ prompt: 'Write' }))).toBe('Plain generated text')
  })

  it.each([
    { name: 'async receipts', output: { request_id: 'pending' } },
    { name: 'tool-only responses', output: { tool_calls: [] } },
    { name: 'nontext responses', output: { response: 42 } },
  ])('rejects $name instead of treating them as completed text', async ({ output }) => {
    const text = await makeText(async () => output)
    const result = await Effect.runPromise(Effect.result(text.generate({ prompt: 'Write' })))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure._tag).toBe('SchemaError')
  })

  it('retains the original native inference error as the WorkersAIError cause', async () => {
    const cause = new Error('synthetic binding failure')
    const text = await makeText(async () => {
      throw cause
    })
    const result = await Effect.runPromise(Effect.result(text.generate({ prompt: 'Write' })))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(WorkersAIError)
      if (result.failure instanceof WorkersAIError) expect(result.failure.cause).toBe(cause)
    }
  })

  it('does not let a caller replace the captured native binding', async () => {
    const text = await makeText(async () => ({ response: 'original' }))
    const unexpected = vi.fn(async () => ({ response: 'replacement' }))
    const result = await Effect.runPromise(
      text
        .generate({ prompt: 'Write' })
        .pipe(
          Effect.provideService(WorkerEnvironment, { AI: { run: unexpected } }),
          Effect.provideService(RuntimeContext, makeWorkerRuntimeContext('replacement')),
        ),
    )
    expect(result).toBe('original')
    expect(unexpected).not.toHaveBeenCalled()
  })

  it('preserves interruption while inference is pending', async () => {
    const started = Deferred.makeUnsafe<void>()
    const text = await makeText(() => {
      Effect.runSync(Deferred.succeed(started, undefined))
      return new Promise<never>(() => {})
    })
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(text.generate({ prompt: 'Write' }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
  })

  it('ordinary Machine.start automatically invokes generation and the next node', async () => {
    const text = await makeText(async () => ({ response: 'generated' }))
    const review = vi.fn()
    const machine = makeMachine(review)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* Machine.start(machine)
          yield* ref.join
          expect(states.matches(yield* ref.state, 'completed')).toBe(true)
        }),
      ).pipe(Effect.provideService(WorkersAiText, text), Effect.timeout('2 seconds')),
    )
    expect(review).toHaveBeenCalledExactlyOnceWith('generated')
  })

  it('ordinary Machine.invoke routes a typed inference failure without invoking the success node', async () => {
    const text = await makeText(async () => {
      throw new Error('synthetic failure')
    })
    const review = vi.fn()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* Machine.start(makeMachine(review))
          yield* ref.join
          expect(states.matches(yield* ref.state, 'failed')).toBe(true)
        }),
      ).pipe(Effect.provideService(WorkersAiText, text), Effect.timeout('2 seconds')),
    )
    expect(review).not.toHaveBeenCalled()
  })

  it('ordinary Machine.resume reacquires a new text service and progresses from the saved invoke state', async () => {
    const machine = makeMachine(vi.fn())
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const text = awaitNeverText
          const ref = yield* Machine.start(machine).pipe(Effect.provideService(WorkersAiText, text))
          return yield* ref.state
        }),
      ),
    )
    const text = await makeText(async () => ({ response: 'resumed' }))
    const review = vi.fn()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* Machine.resume(makeMachine(review), snapshot)
          yield* ref.join
          expect(states.matches(yield* ref.state, 'completed')).toBe(true)
        }),
      ).pipe(Effect.provideService(WorkersAiText, text), Effect.timeout('2 seconds')),
    )
    expect(review).toHaveBeenCalledExactlyOnceWith('resumed')
  })
})

const awaitNeverText: WorkersAiText['Service'] = { generate: () => Effect.never }
