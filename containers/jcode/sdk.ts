import { JcodeClient } from '@1jehuang/jcode-sdk'
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

import { Session, TurnReceipt, type TurnRequest } from '../../src/features/jcode/model'

export class GatewayError extends Data.TaggedError('GatewayError')<{
  readonly status: 404 | 409 | 413 | 503
  readonly code: string
  readonly cause?: unknown
}> {}

const OpenCodeRoute = Schema.String.check(Schema.isPattern(/^opencode\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))
const resolveSdkModel = (model: string) =>
  Schema.decodeUnknownEffect(OpenCodeRoute)(model).pipe(
    Effect.map(String.replace('opencode/', 'opencode:')),
    Effect.mapError((cause) => new GatewayError({ status: 503, code: 'unsupported_model', cause })),
  )

/** Container-owned configuration only. Never inspect or copy host login/config files.
 * Jcode 0.98.1, commit 1c7426eb1, uses [providers.NAME], requires_api_key and
 * <profile>:<model> selectors, not slash-qualified API model identifiers.
 * https://github.com/1jehuang/jcode/blob/1c7426eb1/crates/jcode-config-types/src/lib.rs#L475-L497
 * https://github.com/1jehuang/jcode/blob/1c7426eb1/crates/jcode-provider-metadata/src/catalog.rs#L6-L15
 * https://github.com/1jehuang/jcode/blob/1c7426eb1/crates/jcode-base/src/provider/mod.rs#L901-L924
 */
export const prepareSdkConfiguration = (model: string, home: string) =>
  Effect.gen(function* () {
    yield* resolveSdkModel(model)
    const localModel = String.replace('opencode/', '')(model)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 })
    const filename = path.join(home, 'config.toml')
    // Only validated ASCII model identifiers enter TOML. No credential values are
    // read or written. Even a free model requires an authorized runtime API key.
    const content = Array.join(
      [
        '[provider]',
        'default_provider = "opencode"',
        `default_model = "${localModel}"`,
        'cross_provider_failover = "manual"',
        'same_provider_account_failover = false',
        '',
        '[providers.opencode]',
        'type = "openai-compatible"',
        'base_url = "https://opencode.ai/zen/v1"',
        'auth = "bearer"',
        'api_key_env = "OPENCODE_API_KEY"',
        'requires_api_key = true',
        `default_model = "${localModel}"`,
        '',
        '[[providers.opencode.models]]',
        `id = "${localModel}"`,
        '',
      ],
      '\n',
    )
    yield* fs.writeFileString(`${filename}.flowdeck-next`, content, { mode: 0o600 })
    yield* fs.rename(`${filename}.flowdeck-next`, filename)
  }).pipe(Effect.uninterruptible)

// The SDK owns child processes, Unix sockets and event callbacks. Only this adapter
// crosses its Promise boundary. One scoped client lives for the container lifetime.
export const launchSdk = Effect.acquireRelease(
  Effect.tryPromise(() =>
    JcodeClient.launch({
      binary: '/sandbox/.local/bin/jcode',
      jcodeHome: '/sandbox/.jcode',
      workingDir: '/sandbox/workspace',
      inheritLogins: false,
      swarmModel: 'inherit',
      env: { HOME: '/sandbox' },
    }),
  ),
  (client) => Effect.tryPromise(() => client.close()).pipe(Effect.orDie),
)

export class Gateway extends Context.Service<Gateway, Effect.Success<ReturnType<typeof makeGateway>>>()(
  'flowdeck/JcodeGateway',
) {}

type Sdk = Pick<JcodeClient, 'createSession' | 'attachSession' | 'setModel' | 'run'>
const StoredTurn = Schema.Struct({ digest: Schema.String, receipt: TurnReceipt })
const State = Schema.Struct({
  session: Schema.NullOr(Session),
  creating: Schema.Boolean,
  turns: Schema.Record(Schema.String, StoredTurn),
})
type State = typeof State.Type

export const makeGateway = (client: Sdk, model: string, directory: string) =>
  Effect.gen(function* () {
    const sdkModel = yield* resolveSdkModel(model)
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
      : { session: null, creating: false, turns: {} }
    let attached = false
    let configured = false
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
      if (state.creating) return yield* new GatewayError({ status: 409, code: 'session_creation_interrupted' })
      if (state.session === null) {
        yield* save({ ...state, creating: true })
        const created = yield* sdk(() => client.createSession({ workingDir: '/sandbox/workspace' }))
        // SDK createSession already attaches. A second attach tries to restore
        // a transcript that the new session may not have persisted yet.
        attached = true
        yield* save({ ...state, creating: false, session: { sessionId: created.session_id, model, status: 'active' } })
      }
      const session = state.session
      if (session === null) return yield* new GatewayError({ status: 503, code: 'session_missing' })
      if (session.model !== model) return yield* new GatewayError({ status: 409, code: 'model_changed' })
      if (!attached) {
        yield* sdk(() => client.attachSession(session.sessionId))
        attached = true
      }
      if (!configured) {
        // Translate only the selector syntax, preserving the requested provider
        // and model exactly. Public session.model remains the slash-qualified route.
        yield* sdk(() => client.setModel(session.sessionId, sdkModel))
        configured = true
      }
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
              // An interrupted SDK turn may still be executing in the surviving daemon.
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
                // SDK 1.2.0 can resolve run() on stream EOF without turn_done. Its typed
                // event callback is the interoperability boundary for terminal evidence.
                let done = false
                let failed = false
                const result = yield* sdk(() =>
                  client.run(session.sessionId, request.prompt, {
                    onEvent: (event) => {
                      if (event.ev === 'turn_done') done = true
                      if (event.ev === 'error') failed = true
                    },
                  }),
                ).pipe(Effect.result)
                // Never expose provider errors, tool output, runtime environment or credentials.
                if (failed)
                  return { commandId: request.commandId, status: 'failed', error: 'sdk_failure' } satisfies TurnReceipt
                if (Result.isFailure(result) || !done) {
                  return {
                    commandId: request.commandId,
                    status: 'interrupted',
                    error: 'runtime_interrupted',
                  } satisfies TurnReceipt
                }
                if (result.success.stopReason !== undefined) {
                  return { commandId: request.commandId, status: 'failed', error: 'sdk_failure' } satisfies TurnReceipt
                }
                return String.length(result.success.finalText) > 131_072
                  ? ({ commandId: request.commandId, status: 'failed', error: 'output_limit' } satisfies TurnReceipt)
                  : ({
                      commandId: request.commandId,
                      status: 'completed',
                      text: result.success.finalText,
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
            // Completion does not close the client or delete the workspace.
            return completed
          }),
        )
        .pipe(Effect.uninterruptible),
    }
  })
