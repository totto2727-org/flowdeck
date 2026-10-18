import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { NodeServices } from '@effect/platform-node'
import { Array, Effect, FileSystem, Schedule, Schema, String } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { GatewayModel, launchSdk, makeGateway, type PiSession, type PiSessionFactory } from './sdk'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
type Event = Parameters<Parameters<PiSession['subscribe']>[0]>[0]
type Assistant = Extract<Event, { type: 'message_end' }>['message'] & { role: 'assistant' }
const assistant = (stopReason: Assistant['stopReason'] = 'stop', text = 'done'): Event => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'flowdeck',
    model: GatewayModel,
    stopReason,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
})

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory('tmp', { recursive: true })
  const directory = yield* fs.makeTempDirectoryScoped({ directory: 'tmp', prefix: 'pi-gateway-' })
  let listener: Parameters<PiSession['subscribe']>[0] | undefined
  const emit = (event: Event) => listener?.(event)
  let transcript = ''
  // The fake reproduces Pi's lazy transcript creation, without a model call.
  const prompt = vi.fn<PiSession['prompt']>(async () => {
    await Effect.runPromise(fs.writeFileString(transcript, 'persisted-transcript'))
    emit(assistant())
    emit({ type: 'agent_settled', aborted: false })
  })
  const abort = vi.fn<PiSession['abort']>(async () => {})
  const dispose = vi.fn<PiSession['dispose']>(() => {})
  const factory = vi.fn<PiSessionFactory>(async ({ sessionId, sessionFile }) => {
    transcript = sessionFile ?? `${directory}/${sessionId}.jsonl`
    return {
      sessionId,
      sessionFile: transcript,
      prompt,
      subscribe: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      abort,
      dispose,
    }
  })
  const gateway = yield* makeGateway(factory, GatewayModel, directory)
  return { fs, directory, factory, gateway, prompt, emit, abort, dispose }
})

const terminal = (gateway: Effect.Success<ReturnType<typeof makeGateway>>, commandId: string) =>
  gateway
    .getTurn(commandId)
    .pipe(
      Effect.repeat({ while: (receipt) => receipt.status === 'running', schedule: Schedule.spaced('1 millis') }),
      Effect.timeout('2 seconds'),
    )
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | import('effect').Path.Path | import('effect').Crypto.Crypto | import('effect').Scope.Scope
  >,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)))

describe('direct Pi container gateway', () => {
  it.each(['4c12f851-1d45-4e04-b6e8-7f921447f7e1', '8cab398c-2714-46b2-9d69-4ed57a4263d1'])(
    'sends endpoint-only inference without credentials and correlates SDK session %s',
    async (sessionId) => {
      const registration = vi.spyOn(ModelRuntime.prototype, 'registerProvider')
      try {
        const factory = await Effect.runPromise(
          launchSdk({
            baseUrl: 'http://flowdeck-inference/compat',
          }),
        )
        expect(factory).toBeTypeOf('function')
        expect(registration).toHaveBeenCalledWith(
          'flowdeck',
          expect.objectContaining({
            api: 'openai-completions',
            baseUrl: 'http://flowdeck-inference/compat',
            apiKey: 'unused',
            authHeader: false,
            models: [expect.objectContaining({ id: GatewayModel })],
          }),
        )
        expect(registration.mock.calls[0]?.[1]).not.toHaveProperty('headers')
        const [runtime] = registration.mock.contexts
        if (!(runtime instanceof ModelRuntime)) throw new Error('Expected the real Pi model runtime')
        const model = runtime.getModel('flowdeck', GatewayModel)
        if (model === undefined) throw new Error('Expected the configured Gateway model')
        const transport = vi.fn<typeof globalThis.fetch>(async (input, init) => {
          const request = new Request(input, init)
          expect(request.url).toBe('http://flowdeck-inference/compat/chat/completions')
          expect(request.method).toBe('POST')
          expect(request.headers.has('authorization')).toBe(false)
          expect(request.headers.has('cf-aig-authorization')).toBe(false)
          expect(request.headers.has('x-api-key')).toBe(false)
          expect(request.headers.get('x-opencode-session')).toBe(sessionId)
          expect(await request.json()).toMatchObject({ model: GatewayModel })
          return new Response(
            'data: {"id":"transport-test","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\n' +
              'data: {"id":"transport-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        })
        // Exercise the real Pi and OpenAI request assembly, with only network I/O replaced.
        const response = await runtime.completeSimple(
          { ...model, headers: { 'x-opencode-session': sessionId } },
          {
            messages: [{ role: 'user', content: 'transport fixture only', timestamp: 0 }],
          },
          { fetch: transport, maxRetries: 0 },
        )
        expect(response.stopReason).toBe('stop')
        expect(transport).toHaveBeenCalledTimes(1)
      } finally {
        registration.mockRestore()
      }
    },
  )

  it.each(['openai/model', 'opencode-go/model', 'opencode/"injected"'])(
    'rejects unsupported model %s',
    async (model) => {
      await run(
        Effect.gen(function* () {
          const { factory, directory, fs } = yield* fixture
          expect(yield* makeGateway(factory, model, `${directory}/unsupported`).pipe(Effect.flip)).toMatchObject({
            status: 503,
            code: 'unsupported_model',
          })
          expect(factory).not.toHaveBeenCalled()
          expect(yield* fs.exists(`${directory}/unsupported`)).toBe(false)
        }),
      )
    },
  )

  it('reuses stable identity before the first transcript and reopens the exact transcript after turns', async () => {
    await run(
      Effect.gen(function* () {
        const { gateway, factory, directory, prompt } = yield* fixture
        const first = yield* gateway.ensure
        expect(yield* gateway.ensure).toEqual(first)
        expect(factory).toHaveBeenCalledTimes(1)
        const emptyReplacement = yield* makeGateway(factory, GatewayModel, directory)
        expect(yield* emptyReplacement.ensure).toEqual(first)
        expect(factory).toHaveBeenLastCalledWith({ sessionId: first.sessionId, sessionFile: undefined })
        yield* emptyReplacement.submit({ commandId: 'first', prompt: 'implement' })
        expect(yield* terminal(emptyReplacement, 'first')).toEqual({
          commandId: 'first',
          status: 'completed',
          text: 'done',
        })
        const replacement = yield* makeGateway(factory, GatewayModel, directory)
        expect(yield* replacement.ensure).toEqual(first)
        expect(factory).toHaveBeenLastCalledWith({
          sessionId: first.sessionId,
          sessionFile: `${directory}/${first.sessionId}.jsonl`,
        })
        yield* replacement.submit({ commandId: 'second', prompt: 'verify' })
        expect(yield* terminal(replacement, 'second')).toMatchObject({ status: 'completed' })
        expect(Array.map(prompt.mock.calls, ([text]) => text)).toEqual(['implement', 'verify'])
      }),
    )
  })

  it('uses the official session reopen API without a model or server', async () => {
    await run(
      Effect.gen(function* () {
        const { directory } = yield* fixture
        const id = '4c12f851-1d45-4e04-b6e8-7f921447f7e1'
        const manager = SessionManager.create(directory, `${directory}/sessions`, { id })
        manager.appendMessage({ role: 'user', content: 'persist only', timestamp: 0 })
        const path = manager.getSessionFile()!
        const restored = SessionManager.open(path, undefined, directory)
        expect(restored.getSessionId()).toBe(id)
        expect(restored.buildSessionContext().messages).toEqual([
          { role: 'user', content: 'persist only', timestamp: 0 },
        ])
      }),
    )
  })

  it('never prompts before durable receipt commit, including write failure', async () => {
    await run(
      Effect.gen(function* () {
        const { fs, directory, factory, gateway, prompt } = yield* fixture
        yield* gateway.ensure
        const failing = yield* makeGateway(factory, GatewayModel, directory).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: () => fs.readFileString(`${directory}/missing-for-test`).pipe(Effect.asVoid),
          }),
        )
        expect(
          yield* failing.submit({ commandId: 'uncommitted', prompt: 'must not run' }).pipe(Effect.result),
        ).toMatchObject({ _tag: 'Failure' })
        expect(prompt).not.toHaveBeenCalled()
        expect(yield* gateway.getTurn('uncommitted').pipe(Effect.flip)).toMatchObject({ code: 'turn_not_found' })
      }),
    )
  })

  it('deduplicates retries and rejects mismatches and concurrent turns', async () => {
    await run(
      Effect.gen(function* () {
        const { gateway, prompt, emit, fs, directory } = yield* fixture
        const pending = Promise.withResolvers<void>()
        prompt.mockImplementation(async () => {
          const saved = await Effect.runPromise(fs.readFileString(`${directory}/gateway.json`))
          expect(saved).toContain('"status":"running"')
          await pending.promise
        })
        const request = { commandId: 'same', prompt: 'work' }
        expect(
          yield* Effect.all([gateway.submit(request), gateway.submit(request)], { concurrency: 'unbounded' }),
        ).toEqual([
          { commandId: 'same', status: 'running' },
          { commandId: 'same', status: 'running' },
        ])
        expect(yield* gateway.submit({ ...request, prompt: 'different' }).pipe(Effect.flip)).toMatchObject({
          code: 'command_mismatch',
        })
        expect(yield* gateway.submit({ commandId: 'other', prompt: 'work' }).pipe(Effect.flip)).toMatchObject({
          code: 'turn_busy',
        })
        expect(yield* gateway.complete.pipe(Effect.flip)).toMatchObject({ code: 'turn_busy' })
        emit(assistant())
        emit({ type: 'agent_settled', aborted: false })
        pending.resolve()
        expect(yield* terminal(gateway, 'same')).toEqual({ commandId: 'same', status: 'completed', text: 'done' })
        expect(yield* gateway.submit(request)).toMatchObject({ status: 'completed' })
        expect(prompt).toHaveBeenCalledTimes(1)
      }),
    )
  })

  it('marks crash-interrupted work and never replays it', async () => {
    await run(
      Effect.gen(function* () {
        const { fs, directory, factory, gateway, prompt } = yield* fixture
        const session = yield* gateway.ensure
        yield* fs.writeFileString(
          `${directory}/gateway.json`,
          encodeJson({
            session,
            sessionFile: `${directory}/${session.sessionId}.jsonl`,
            turns: { old: { digest: 'not-resubmittable', receipt: { commandId: 'old', status: 'running' } } },
          }),
        )
        const replacement = yield* makeGateway(factory, GatewayModel, directory)
        expect(yield* replacement.getTurn('old')).toEqual({
          commandId: 'old',
          status: 'interrupted',
          error: 'runtime_interrupted',
        })
        expect(
          yield* replacement.submit({ commandId: 'new', prompt: 'do not replay' }).pipe(Effect.flip),
        ).toMatchObject({ code: 'recovery_required' })
        expect(yield* replacement.complete.pipe(Effect.flip)).toMatchObject({ code: 'recovery_required' })
        expect(prompt).not.toHaveBeenCalled()
      }),
    )
  })

  it('fails closed if a transcript disappears after accepted work', async () => {
    await run(
      Effect.gen(function* () {
        const { gateway, factory, directory, fs } = yield* fixture
        const session = yield* gateway.ensure
        yield* gateway.submit({ commandId: 'done', prompt: 'work' })
        yield* terminal(gateway, 'done')
        yield* fs.remove(`${directory}/${session.sessionId}.jsonl`)
        const replacement = yield* makeGateway(factory, GatewayModel, directory)
        expect(yield* replacement.ensure.pipe(Effect.flip)).toMatchObject({ code: 'session_transcript_missing' })
        expect(factory).toHaveBeenCalledTimes(1)
        expect(yield* replacement.getTurn('done')).toMatchObject({ status: 'completed' })
      }),
    )
  })

  it.each([
    ['no_settlement', 'interrupted'],
    ['aborted', 'interrupted'],
    ['error', 'failed'],
    ['length', 'failed'],
    ['toolUse', 'failed'],
    ['pending', 'interrupted'],
    ['rejected', 'interrupted'],
    ['oversized', 'failed'],
  ] as const)('classifies %s without leaking private diagnostics', async (outcome, status) => {
    await run(
      Effect.gen(function* () {
        const { gateway, prompt, emit } = yield* fixture
        prompt.mockImplementation(async () => {
          if (outcome === 'rejected') throw new Error('private-token')
          emit(
            assistant(
              outcome === 'error' || outcome === 'length' || outcome === 'toolUse' || outcome === 'pending'
                ? outcome
                : 'stop',
              outcome === 'oversized' ? String.repeat(131_073)('x') : 'private-output',
            ),
          )
          if (outcome !== 'no_settlement') emit({ type: 'agent_settled', aborted: outcome === 'aborted' })
        })
        yield* gateway.submit({ commandId: 'outcome', prompt: 'work' })
        const receipt = yield* terminal(gateway, 'outcome')
        expect(receipt).toMatchObject({ status })
        expect(encodeJson(receipt)).not.toContain('private')
      }),
    )
  })

  it('refuses changed models, keeps completed receipts and files, and disposes the scoped session', async () => {
    const controls = await run(
      Effect.gen(function* () {
        const { gateway, factory, directory, fs, abort, dispose } = yield* fixture
        yield* fs.writeFileString(`${directory}/workspace-proof`, 'keep')
        yield* gateway.submit({ commandId: 'done', prompt: 'work' })
        yield* terminal(gateway, 'done')
        expect(yield* gateway.complete).toMatchObject({ status: 'completed' })
        expect(yield* gateway.submit({ commandId: 'later', prompt: 'no' }).pipe(Effect.flip)).toMatchObject({
          code: 'work_completed',
        })
        const replacement = yield* makeGateway(factory, GatewayModel, directory)
        expect(yield* replacement.ensure).toMatchObject({ status: 'completed' })
        expect(yield* replacement.getTurn('done')).toMatchObject({ status: 'completed', text: 'done' })
        expect(yield* fs.readFileString(`${directory}/workspace-proof`)).toBe('keep')
        const saved = yield* fs.readFileString(`${directory}/gateway.json`)
        yield* fs.writeFileString(`${directory}/gateway.json`, String.replace(GatewayModel, 'another/model')(saved))
        const changed = yield* makeGateway(factory, GatewayModel, directory)
        expect(yield* changed.ensure.pipe(Effect.flip)).toMatchObject({ code: 'model_changed' })
        return { abort, dispose }
      }),
    )
    expect(controls.abort).toHaveBeenCalled()
    expect(controls.dispose).toHaveBeenCalled()
  })
})
