import { BrowserCrypto } from '@effect/platform-browser'
import { Effect, Function, Layer, Logger } from 'effect'
import type { Schema } from 'effect'

import { rpcResponse } from './boundary.ts'

// oxlint-disable-next-line unicorn/no-null -- Successful command acknowledgements are JSON null on the public wire.
export const jsonAcknowledgement = null

const services = Layer.mergeAll(BrowserCrypto.layer, Logger.layer([Logger.make(Function.constVoid)]))

export const wireReply = <E>(operation: string, effect: Effect.Effect<Schema.Json, E>): Effect.Effect<string> => {
  const encoded = rpcResponse(operation)(effect)
  return Effect.provide(encoded, services)
}

export const response = (value: Schema.Json): Effect.Effect<string> => wireReply('child.test', Effect.succeed(value))
