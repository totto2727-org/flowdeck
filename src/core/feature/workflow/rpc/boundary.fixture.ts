import { BrowserCrypto } from '@effect/platform-browser'
import { Effect, Logger, References, Schema } from 'effect'
import type { Crypto, Exit } from 'effect'

import { ExternalError } from '@/core/feature/workflow/domain/errors'

import { rpcResponse, rpcResult } from './boundary.ts'
import { RemoteWorkerError, Rfc9457ProblemDetailsSchema } from './problem.ts'

type LoggedEntry = Logger.Options<unknown> & Readonly<{ annotations: Readonly<Record<string, unknown>> }>
type Captured<R, E> = Readonly<{ entries: LoggedEntry[]; exit: Exit.Exit<R, E> }>

export const capture = <A, E>(operation: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<Captured<A, E>> =>
  Effect.gen(function* () {
    const entries: LoggedEntry[] = []
    const logger = Logger.make((entry) => {
      entries.push({ ...entry, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) })
    })
    const exit = yield* operation.pipe(
      Effect.exit,
      Effect.provide(BrowserCrypto.layer),
      Effect.provide(Logger.layer([logger])),
    )
    return { entries, exit }
  })

const jsonText = Schema.fromJsonString(Schema.Json)
const standardReply = Schema.Result(Schema.Json, Rfc9457ProblemDetailsSchema)
const nativeReply = Schema.Result(Schema.Json, Schema.Json)
const standardWire = Schema.fromJsonString(Schema.toCodecJson(standardReply))
const peerWire = Schema.fromJsonString(Schema.toCodecJson(nativeReply))

export const parse = Schema.decodeEffect(jsonText)
export const decodeStandard = Schema.decodeEffect(standardWire, { onExcessProperty: 'error' })
export const encodeStandard = Schema.encodeEffect(standardWire, { onExcessProperty: 'error' })
export const encodePeer = Schema.encodeEffect(peerWire)

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Simulate peer input that violates the string codec.
export const decodeString = Schema.decodeUnknownEffect(Schema.String)

export const originalError = (message: string): Error =>
  // oxlint-disable-next-line rules/require-tagged-error -- Exercise native findings at the RPC boundary.
  new Error(message)

export const encodeChildFailure = (reported: unknown): Effect.Effect<Captured<string, never>> =>
  capture(Effect.fail(reported).pipe(rpcResponse('child')))

export const readRemoteFailure = Effect.fn('flowdeck.test.boundaryReadRemoteFailure')(function* (
  operation: string,
  wire: string,
) {
  const local = yield* Effect.flip(rpcResult(operation)(wire))
  if (!(local instanceof RemoteWorkerError)) {
    return yield* local
  }
  return local
})

export const readInvalidReply = Effect.fn('flowdeck.test.boundaryReadInvalidReply')(function* (input: unknown) {
  const local = yield* Effect.flip(rpcResult('decode')(input))
  if (!(local instanceof ExternalError)) {
    return yield* local
  }
  return local
})
