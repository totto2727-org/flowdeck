import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent'
import {
  Array,
  Context,
  Crypto,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  Record,
  Result,
  Schema,
  Semaphore,
  String,
} from 'effect'
import { Hex } from 'effect/encoding'

import { Session, TurnReceipt, type TurnRequest } from '../../src/features/development/model'

export class GatewayError extends Data.TaggedError('GatewayError')<{
  readonly status: 404 | 409 | 413 | 503
  readonly code: string
  readonly cause?: unknown
}> {}

export const GatewayModel = 'custom-opencode-go/deepseek-v4.1-flash'
const SupportedModel = Schema.Literal(GatewayModel)
const resolveSdkModel = (model: string) =>
  Schema.decodeUnknownEffect(SupportedModel)(model).pipe(
    Effect.mapError((cause) => new GatewayError({ status: 503, code: 'unsupported_model', cause })),
  )

export type PiSession = Pick<AgentSession, 'sessionId' | 'sessionFile' | 'prompt' | 'subscribe' | 'abort' | 'dispose'>
export type PiSessionFactory = (options: {
  readonly sessionId: string
  readonly sessionFile: string | undefined
}) => Promise<PiSession>

/** Pi's Promise APIs are the SDK interoperability boundary. Inference auth belongs to the Worker.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/sdk.ts
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/provider-composer.ts
 */
export const launchSdk = (config: { readonly baseUrl: string }) =>
  Effect.tryPromise(async (): Promise<PiSessionFactory> => {
    const cwd = '/home/sandbox/workspace'
    const agentDir = '/home/sandbox/.pi/agent'
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    })
    modelRuntime.registerProvider('flowdeck', {
      api: 'openai-completions',
      baseUrl: config.baseUrl,
      // Pi requires a local auth marker. No credential is supplied to the Container.
      apiKey: 'unused',
      authHeader: false,
      // OpenAI adds its own Bearer header even with authHeader:false. Pi's request
      // header null sentinel suppresses that default before Worker-owned inference.
      streamSimple: (model, context, options) =>
        streamSimple(model, context, {
          ...options,
          headers: { ...options?.headers, Authorization: null },
        }),
      models: [
        {
          id: GatewayModel,
          name: GatewayModel,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131_072,
          maxTokens: 8192,
        },
      ],
    })
    const model = modelRuntime.getModel('flowdeck', GatewayModel)
    if (model === undefined) throw new Error('Gateway model is unavailable')
    return async ({ sessionId, sessionFile }) => {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, cacheWarming: 'off' })
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      })
      await resourceLoader.reload()
      const sessionManager =
        sessionFile === undefined
          ? SessionManager.create(cwd, '/home/sandbox/.flowdeck/sessions', { id: sessionId })
          : SessionManager.open(sessionFile, undefined, cwd)
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        // Correlation only, never authorization. The persisted SDK UUID survives reopen.
        model: { ...model, headers: { 'x-opencode-session': sessionId } },
        thinkingLevel: 'off',
        tools: ['read', 'bash', 'edit', 'write'],
        sessionManager,
        settingsManager,
        resourceLoader,
      })
      if (session.sessionId !== sessionId) {
        session.dispose()
        throw new Error('Session identity mismatch')
      }
      return session
    }
  })

export class Gateway extends Context.Service<Gateway, Effect.Success<ReturnType<typeof makeGateway>>>()(
  'flowdeck/PiGateway',
) {}

const StoredTurn = Schema.Struct({ digest: Schema.String, receipt: TurnReceipt })
const State = Schema.Struct({
  session: Schema.NullOr(Session),
  sessionFile: Schema.NullOr(Schema.String),
  turns: Schema.Record(Schema.String, StoredTurn),
})
type State = typeof State.Type

export const makeGateway = (factory: PiSessionFactory, model: string, directory: string) =>
  Effect.gen(function* () {
    yield* resolveSdkModel(model)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const scope = yield* Effect.scope
    const lock = yield* Semaphore.make(1)
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const filename = path.join(directory, 'gateway.json')
    const exists = yield* fs.exists(filename)
    let state: State = exists
      ? yield* fs
          .readFileString(filename)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(State))))
      : { session: null, sessionFile: null, turns: {} }
    let pi: PiSession | undefined
    yield* Effect.addFinalizer(() =>
      pi === undefined
        ? Effect.void
        : Effect.tryPromise(() => pi!.abort()).pipe(Effect.ensuring(Effect.sync(() => pi!.dispose())), Effect.orDie),
    )
    // Write, fsync and rename before acknowledging or sending any model message.
    const save = (next: State) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(`${filename}.next`, { flag: 'w', mode: 0o600 })
            yield* file.writeAll(new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(State))(next)))
            yield* file.sync
          }),
        )
        yield* fs.rename(`${filename}.next`, filename)
        state = next
        yield* Effect.scoped(
          Effect.gen(function* () {
            const parent = yield* fs.open(directory, { flag: 'r' })
            yield* parent.sync
          }),
        )
      }).pipe(Effect.uninterruptible)
    const recovered = Record.map(state.turns, (turn) =>
      turn.receipt.status === 'running'
        ? {
            ...turn,
            receipt: {
              commandId: turn.receipt.commandId,
              status: 'interrupted' as const,
              error: 'runtime_interrupted' as const,
            },
          }
        : turn,
    )
    if (Array.some(Record.values(state.turns), (turn) => turn.receipt.status === 'running')) {
      yield* save({ ...state, turns: recovered })
    }
    const sdk = <A>(evaluate: () => Promise<A>) =>
      Effect.tryPromise(evaluate).pipe(
        Effect.mapError((cause) => new GatewayError({ status: 503, code: 'sdk_unavailable', cause })),
      )
    const ensure = Effect.gen(function* () {
      if (state.session === null) {
        const sessionId = yield* crypto.randomUUIDv4()
        yield* save({ ...state, session: { sessionId, model, status: 'active' } })
      }
      const session = state.session
      if (session === null) return yield* new GatewayError({ status: 503, code: 'session_missing' })
      if (session.model !== model) return yield* new GatewayError({ status: 409, code: 'model_changed' })
      if (pi === undefined) {
        const transcriptExists = state.sessionFile !== null && (yield* fs.exists(state.sessionFile))
        if (!transcriptExists && Record.size(state.turns) > 0)
          return yield* new GatewayError({ status: 409, code: 'session_transcript_missing' })
        pi = yield* sdk(() =>
          factory({
            sessionId: session.sessionId,
            sessionFile: transcriptExists ? state.sessionFile! : undefined,
          }),
        )
        if (pi.sessionId !== session.sessionId || pi.sessionFile === undefined) {
          pi.dispose()
          pi = undefined
          return yield* new GatewayError({ status: 503, code: 'session_identity_mismatch' })
        }
      }
      if (state.sessionFile !== pi.sessionFile) yield* save({ ...state, sessionFile: pi.sessionFile! })
      return session
    })
    const busy = () => Array.some(Record.values(state.turns), (turn) => turn.receipt.status === 'running')
    const commitReceipt = (commandId: string, receipt: TurnReceipt) =>
      lock.withPermit(
        Effect.gen(function* () {
          const turn = Record.get(state.turns, commandId)
          if (Option.isSome(turn)) {
            yield* save({ ...state, turns: Record.set(state.turns, commandId, { ...turn.value, receipt }) })
          }
        }),
      )
    return {
      ensure: lock.withPermit(ensure).pipe(Effect.uninterruptible),
      getTurn: (commandId: string) =>
        lock.withPermit(
          Effect.gen(function* () {
            const turn = Record.get(state.turns, commandId)
            if (Option.isNone(turn)) return yield* new GatewayError({ status: 404, code: 'turn_not_found' })
            return turn.value.receipt
          }),
        ),
      submit: (request: TurnRequest) =>
        lock
          .withPermit(
            Effect.gen(function* () {
              const digest = Hex.encode(yield* crypto.digest('SHA-256', new TextEncoder().encode(request.prompt)))
              const prior = Record.get(state.turns, request.commandId)
              if (Option.isSome(prior)) {
                if (prior.value.digest !== digest)
                  return yield* new GatewayError({ status: 409, code: 'command_mismatch' })
                return prior.value.receipt
              }
              if (busy()) return yield* new GatewayError({ status: 409, code: 'turn_busy' })
              // Interrupted work requires explicit workflow-owned recovery, never replay.
              if (Array.some(Record.values(state.turns), (turn) => turn.receipt.status === 'interrupted')) {
                return yield* new GatewayError({ status: 409, code: 'recovery_required' })
              }
              if (Record.size(state.turns) >= 256) return yield* new GatewayError({ status: 409, code: 'turn_limit' })
              const session = yield* ensure
              if (session.status === 'completed')
                return yield* new GatewayError({ status: 409, code: 'work_completed' })
              const receipt: TurnReceipt = { commandId: request.commandId, status: 'running' }
              yield* save({ ...state, turns: Record.set(state.turns, request.commandId, { digest, receipt }) })
              const execute = Effect.gen(function* () {
                const active = pi!
                let settled = false
                let aborted = false
                let stopReason: string | undefined
                let text = ''
                const unsubscribe = active.subscribe((event) => {
                  if (event.type === 'agent_settled') {
                    settled = true
                    aborted = event.aborted
                  }
                  if (event.type === 'message_end' && event.message.role === 'assistant') {
                    stopReason = event.message.stopReason
                    text = Array.join(
                      Array.flatMap(event.message.content, (part) => (part.type === 'text' ? [part.text] : [])),
                      '',
                    )
                  }
                })
                const result = yield* sdk(() => active.prompt(request.prompt, { expandPromptTemplates: false })).pipe(
                  Effect.result,
                  Effect.ensuring(Effect.sync(unsubscribe)),
                )
                // Never expose provider errors, tool output, runtime environment or credentials.
                if (
                  stopReason === 'error' ||
                  stopReason === 'length' ||
                  stopReason === 'toolUse' ||
                  stopReason === 'deferred'
                )
                  return { commandId: request.commandId, status: 'failed', error: 'sdk_failure' } satisfies TurnReceipt
                if (Result.isFailure(result) || !settled || aborted || stopReason !== 'stop') {
                  return {
                    commandId: request.commandId,
                    status: 'interrupted',
                    error: 'runtime_interrupted',
                  } satisfies TurnReceipt
                }
                return String.length(text) > 131_072
                  ? ({ commandId: request.commandId, status: 'failed', error: 'output_limit' } satisfies TurnReceipt)
                  : ({
                      commandId: request.commandId,
                      status: 'completed',
                      text,
                    } satisfies TurnReceipt)
              }).pipe(
                Effect.flatMap((terminal) => commitReceipt(request.commandId, terminal)),
                Effect.orDie,
              )
              // The container scope, not the HTTP request scope, owns accepted work.
              yield* Effect.forkIn(execute, scope)
              return receipt
            }),
          )
          .pipe(Effect.uninterruptible),
      complete: lock
        .withPermit(
          Effect.gen(function* () {
            if (busy()) return yield* new GatewayError({ status: 409, code: 'turn_busy' })
            if (Array.some(Record.values(state.turns), (turn) => turn.receipt.status === 'interrupted')) {
              return yield* new GatewayError({ status: 409, code: 'recovery_required' })
            }
            const session = yield* ensure
            const completed: Session = { ...session, status: 'completed' }
            yield* save({ ...state, session: completed })
            // Completion does not delete the transcript or workspace.
            return completed
          }),
        )
        .pipe(Effect.uninterruptible),
    }
  })
