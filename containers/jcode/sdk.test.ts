import type { JcodeClient, RunOptions, SessionInfo, TurnResult } from '@1jehuang/jcode-sdk'
import { NodeServices } from '@effect/platform-node'
import { Array, Effect, FileSystem, Schedule, Schema, String } from 'effect'
import { Toml } from 'effect/encoding'
import { describe, expect, it, vi } from 'vite-plus/test'

import { makeGateway, prepareRelaySession, prepareSdkConfiguration } from './sdk'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const model = 'custom-opencode-go/deepseek-v4.1-flash'
const sdkModel = 'flowdeck:custom-opencode-go/deepseek-v4.1-flash'
const session: SessionInfo = { session_id: 'session-one', status: 'idle', working_dir: '/home/sandbox/workspace' }
const output: TurnResult = { text: 'done', finalText: 'done', messages: [], reasoning: '', toolCalls: [] }

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory('tmp', { recursive: true })
  const directory = yield* fs.makeTempDirectoryScoped({ directory: 'tmp', prefix: 'jcode-gateway-' })
  const client = {
    createSession: vi.fn<JcodeClient['createSession']>(async () => session),
    attachSession: vi.fn<JcodeClient['attachSession']>(async () => session),
    setModel: vi.fn<JcodeClient['setModel']>(async () => {}),
    run: vi.fn<JcodeClient['run']>(async (_sessionId, _prompt, options) => {
      options?.onEvent?.({ ev: 'turn_done', session_id: session.session_id })
      return output
    }),
  }
  const gateway = yield* makeGateway(client, model, directory)
  return { fs, directory, client, gateway }
})

const terminal = (gateway: Effect.Success<ReturnType<typeof makeGateway>>, commandId: string) =>
  gateway
    .getTurn(commandId)
    .pipe(
      Effect.repeat({ while: (receipt) => receipt.status === 'running', schedule: Schedule.spaced('1 millis') }),
      Effect.timeout('2 seconds'),
    )

describe('persistent Jcode container gateway', () => {
  it('writes the official non-secret profile and pins the same provider and model', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory } = yield* fixture
          const home = `${directory}/jcode-home`
          yield* prepareSdkConfiguration(model, home)
          yield* prepareSdkConfiguration(model, home)
          expect(Toml.parse(yield* fs.readFileString(`${home}/config.toml`))).toEqual({
            provider: {
              default_provider: 'flowdeck',
              default_model: model,
              cross_provider_failover: 'manual',
              same_provider_account_failover: false,
            },
            providers: {
              flowdeck: {
                type: 'openai-compatible',
                base_url: 'http://127.0.0.1:8081/v1',
                auth: 'none',
                requires_api_key: false,
                default_model: model,
                models: [{ id: model }],
              },
            },
          })
          expect((yield* fs.stat(`${home}/config.toml`)).mode & 0o777).toBe(0o600)
          expect(yield* fs.exists(`${home}/config.toml.flowdeck-next`)).toBe(false)
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it.each([
    'openai/model',
    'opencode-go/model',
    'opencode:',
    'opencode/a/b',
    'opencode/"injected"',
    'opencode/deepseek-v4.1-flash-free',
  ])('rejects unsupported route %s before writing config or calling the SDK', async (route) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory, client } = yield* fixture
          const home = `${directory}/unconfigured`
          expect(yield* prepareSdkConfiguration(route, home).pipe(Effect.flip)).toMatchObject({
            status: 503,
            code: 'unsupported_model',
          })
          expect(yield* fs.exists(home)).toBe(false)
          expect(yield* makeGateway(client, route, `${directory}/unsupported`).pipe(Effect.flip)).toMatchObject({
            status: 503,
            code: 'unsupported_model',
          })
          expect(client.createSession).not.toHaveBeenCalled()
          expect(client.setModel).not.toHaveBeenCalled()
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })
  it('never sends a prompt when persisting its receipt fails', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory, client, gateway } = yield* fixture
          yield* gateway.ensure
          const failing = yield* makeGateway(client, model, directory).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              rename: () => fs.readFileString(`${directory}/missing-for-test`).pipe(Effect.asVoid),
            }),
          )
          const result = yield* failing.submit({ commandId: 'uncommitted', prompt: 'must not run' }).pipe(Effect.result)
          expect(result).toMatchObject({ _tag: 'Failure' })
          expect(client.run).not.toHaveBeenCalled()
          const replacement = yield* makeGateway(client, model, directory)
          expect(yield* replacement.getTurn('uncommitted').pipe(Effect.flip)).toMatchObject({ code: 'turn_not_found' })
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('refuses a changed runtime model for an already persisted session', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory, client, gateway } = yield* fixture
          yield* gateway.ensure
          const persisted = yield* fs.readFileString(`${directory}/gateway.json`)
          yield* fs.writeFileString(`${directory}/gateway.json`, String.replace(model, 'another/model')(persisted))
          const replacement = yield* makeGateway(client, model, directory)
          expect(yield* replacement.ensure.pipe(Effect.flip)).toMatchObject({ status: 409, code: 'model_changed' })
          expect(client.setModel).toHaveBeenCalledTimes(1)
          expect(client.run).not.toHaveBeenCalled()
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('persists a header-safe inference identity across gateway replacement without credentials', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory } = yield* fixture
          const first = yield* prepareRelaySession(directory)
          expect(first).toMatch(/^[a-f0-9-]{36}$/)
          expect(yield* prepareRelaySession(directory)).toBe(first)
          expect(yield* fs.readFileString(`${directory}/inference-session`)).toBe(first)
          expect((yield* fs.stat(`${directory}/inference-session`)).mode & 0o777).toBe(0o600)
          yield* fs.writeFileString(`${directory}/inference-session`, 'bad\r\nheader')
          expect(yield* prepareRelaySession(directory).pipe(Effect.result)).toMatchObject({ _tag: 'Failure' })
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('reuses one session across ensure, two turns and gateway replacement', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { directory, client, gateway } = yield* fixture
          const first = yield* gateway.ensure
          expect(yield* gateway.ensure).toEqual(first)
          expect(client.attachSession).not.toHaveBeenCalled()
          expect(client.setModel).toHaveBeenCalledExactlyOnceWith('session-one', sdkModel)
          yield* gateway.submit({ commandId: 'run:implement:1', prompt: 'implement' })
          expect(yield* terminal(gateway, 'run:implement:1')).toEqual({
            commandId: 'run:implement:1',
            status: 'completed',
            text: 'done',
          })
          const replacement = yield* makeGateway(client, model, directory)
          expect(yield* replacement.ensure).toEqual(first)
          expect(yield* replacement.ensure).toEqual(first)
          expect(client.attachSession).toHaveBeenCalledExactlyOnceWith('session-one')
          expect(client.setModel).toHaveBeenCalledTimes(2)
          yield* replacement.submit({ commandId: 'run:verify:1', prompt: 'verify' })
          expect(yield* terminal(replacement, 'run:verify:1')).toEqual({
            commandId: 'run:verify:1',
            status: 'completed',
            text: 'done',
          })
          expect(client.createSession).toHaveBeenCalledTimes(1)
          expect(client.createSession).toHaveBeenCalledWith({ workingDir: '/home/sandbox/workspace' })
          expect(first.model).toBe(model)
          expect(client.setModel).toHaveBeenCalledWith('session-one', sdkModel)
          expect(Array.map(client.run.mock.calls, ([id]) => id)).toEqual(['session-one', 'session-one'])
          expect(Array.map(client.run.mock.calls, ([, , options]) => options?.autoApprove)).toEqual([true, true])
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('deduplicates concurrent retries, rejects mismatched IDs and conflicts while busy', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory, client, gateway } = yield* fixture
          const pending = Promise.withResolvers<TurnResult>()
          let options: RunOptions | undefined
          // The receipt must already be durable when the SDK sees the prompt.
          client.run.mockImplementation(async (_id, _prompt, supplied) => {
            options = supplied
            const text = await Effect.runPromise(fs.readFileString(`${directory}/gateway.json`))
            expect(text).toContain('"status":"running"')
            return pending.promise
          })
          const request = { commandId: 'same', prompt: 'work' }
          expect(
            yield* Effect.all([gateway.submit(request), gateway.submit(request)], { concurrency: 'unbounded' }),
          ).toEqual([
            { commandId: 'same', status: 'running' },
            { commandId: 'same', status: 'running' },
          ])
          expect(yield* gateway.submit({ ...request, prompt: 'different' }).pipe(Effect.flip)).toMatchObject({
            status: 409,
            code: 'command_mismatch',
          })
          expect(yield* gateway.submit({ commandId: 'other', prompt: 'work' }).pipe(Effect.flip)).toMatchObject({
            status: 409,
            code: 'turn_busy',
          })
          expect(yield* gateway.complete.pipe(Effect.flip)).toMatchObject({ status: 409, code: 'turn_busy' })
          options?.onEvent?.({ ev: 'turn_done', session_id: 'session-one' })
          pending.resolve(output)
          expect(yield* terminal(gateway, 'same')).toEqual({ commandId: 'same', status: 'completed', text: 'done' })
          expect(yield* gateway.submit(request)).toEqual({ commandId: 'same', status: 'completed', text: 'done' })
          expect(client.run).toHaveBeenCalledTimes(1)
          const replacement = yield* makeGateway(client, model, directory)
          expect(yield* replacement.submit(request)).toEqual({ commandId: 'same', status: 'completed', text: 'done' })
          expect(client.run).toHaveBeenCalledTimes(1)
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('marks persisted running receipts interrupted and never silently resubmits them', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory, client, gateway } = yield* fixture
          yield* gateway.ensure
          yield* fs.writeFileString(
            `${directory}/gateway.json`,
            encodeJson({
              session: { sessionId: 'session-one', model, status: 'active' },
              creating: false,
              turns: { old: { digest: 'not-resubmittable', receipt: { commandId: 'old', status: 'running' } } },
            }),
          )
          const replacement = yield* makeGateway(client, model, directory)
          expect(yield* replacement.getTurn('old')).toEqual({
            commandId: 'old',
            status: 'interrupted',
            error: 'runtime_interrupted',
          })
          expect(
            yield* replacement.submit({ commandId: 'new', prompt: 'do not rerun' }).pipe(Effect.flip),
          ).toMatchObject({ status: 409, code: 'recovery_required' })
          expect(yield* replacement.complete.pipe(Effect.flip)).toMatchObject({
            status: 409,
            code: 'recovery_required',
          })
          expect(client.run).not.toHaveBeenCalled()
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('treats SDK EOF without turn_done as interruption, not success', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, gateway } = yield* fixture
          client.run.mockResolvedValue(output)
          yield* gateway.submit({ commandId: 'eof', prompt: 'work' })
          expect(yield* terminal(gateway, 'eof')).toEqual({
            commandId: 'eof',
            status: 'interrupted',
            error: 'runtime_interrupted',
          })
          expect(yield* gateway.submit({ commandId: 'next', prompt: 'work' }).pipe(Effect.flip)).toMatchObject({
            code: 'recovery_required',
          })
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('does not expose SDK errors or select a fallback model', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, gateway } = yield* fixture
          client.setModel.mockRejectedValue(new Error('private-token'))
          expect(yield* gateway.ensure.pipe(Effect.flip)).toMatchObject({ status: 503, code: 'sdk_unavailable' })
          expect(client.run).not.toHaveBeenCalled()
          expect(client.setModel).toHaveBeenCalledWith('session-one', sdkModel)
          expect(client.createSession).toHaveBeenCalledTimes(1)
          expect(client.attachSession).not.toHaveBeenCalled()
          client.setModel.mockResolvedValue(undefined)
          expect(yield* gateway.ensure).toEqual({ sessionId: 'session-one', model, status: 'active' })
          expect(client.createSession).toHaveBeenCalledTimes(1)
          expect(client.attachSession).not.toHaveBeenCalled()
          expect(client.setModel).toHaveBeenCalledTimes(2)
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('keeps workspace files and terminal receipts after complete', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory, client, gateway } = yield* fixture
          yield* fs.writeFileString(`${directory}/workspace-proof`, 'keep')
          yield* gateway.submit({ commandId: 'done', prompt: 'work' })
          yield* terminal(gateway, 'done')
          expect(yield* gateway.complete).toEqual({ sessionId: 'session-one', model, status: 'completed' })
          expect(yield* gateway.ensure).toEqual({ sessionId: 'session-one', model, status: 'completed' })
          expect(yield* gateway.submit({ commandId: 'later', prompt: 'no' }).pipe(Effect.flip)).toMatchObject({
            status: 409,
            code: 'work_completed',
          })
          const replacement = yield* makeGateway(client, model, directory)
          expect(yield* replacement.ensure).toEqual({ sessionId: 'session-one', model, status: 'completed' })
          expect(yield* fs.readFileString(`${directory}/workspace-proof`)).toBe('keep')
          expect(yield* replacement.getTurn('done')).toEqual({ commandId: 'done', status: 'completed', text: 'done' })
          expect(yield* replacement.getTurn('unknown').pipe(Effect.flip)).toMatchObject({
            status: 404,
            code: 'turn_not_found',
          })
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('fails closed when session creation was interrupted', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, directory, client } = yield* fixture
          yield* fs.writeFileString(
            `${directory}/gateway.json`,
            encodeJson({ session: null, creating: true, turns: {} }),
          )
          const replacement = yield* makeGateway(client, model, directory)
          expect(yield* replacement.ensure.pipe(Effect.flip)).toMatchObject({
            status: 409,
            code: 'session_creation_interrupted',
          })
          expect(client.createSession).not.toHaveBeenCalled()
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  })
})
