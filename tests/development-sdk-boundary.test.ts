import { live } from '@effect/vitest'
import { Effect, Schedule, Schema } from 'effect'
import { describe, expect } from 'vite-plus/test'

import { openDevelopmentSdk } from './fixtures/development-sdk-host.ts'

const startupTimeout = 60_000
const idle = { jobs: 0, sqlite: 1 }
const awaitAlarm = { schedule: Schedule.spaced('20 millis'), times: 50 }
const idleState = Schema.Struct({
  jobs: Schema.Literal(idle.jobs),
  sqlite: Schema.Literal(idle.sqlite),
})
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The Miniflare adapter reads raw JSON from the worker.
const readIdle = Schema.decodeUnknownEffect(idleState)
const capnwebError = Schema.Struct({
  accepted: Schema.Literal(false),
  message: Schema.String,
  name: Schema.Literal('DataCloneError'),
})
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The native service may return malformed JSON at the RPC boundary.
const readCapnwebError = Schema.decodeUnknownEffect(capnwebError)
const exact = { onExcessProperty: 'error' } as const

describe('alchemy Effect DO and official native SDK raw boundary', () => {
  live(
    'starts the production PiHarness in an Effect DO with SQLite and no external I/O',
    () =>
      Effect.gen(function* () {
        const { read } = yield* openDevelopmentSdk
        expect(yield* read()).toStrictEqual(idle)
        expect(yield* read('/fetch')).toStrictEqual({ jobs: 0 })
      }).pipe(Effect.scoped),
    startupTimeout,
  )

  live(
    'rejects a Capnweb target sent as a native Cloudflare RPC capability',
    () =>
      Effect.gen(function* () {
        const { read } = yield* openDevelopmentSdk
        const reply = yield* read('/capnweb')
        const failure = yield* readCapnwebError(reply, exact)
        expect(failure.message).toContain('WorkspaceStub')
      }).pipe(Effect.scoped),
    startupTimeout,
  )

  live(
    'retains WorkspaceProxy in the Effect bundle when the plugin is registered twice',
    () =>
      Effect.gen(function* () {
        const { exports, read } = yield* openDevelopmentSdk
        expect(exports).toStrictEqual(expect.arrayContaining(['SdkBoundary', 'WorkspaceProxy', 'default']))
        expect(yield* read('/proxy')).toStrictEqual({ status: 200, text: 'ok\n' })
      }).pipe(Effect.scoped),
    startupTimeout,
  )

  live(
    'forwards a real workerd alarm to the official Lifecycle job queue',
    () =>
      Effect.gen(function* () {
        const { read } = yield* openDevelopmentSdk
        expect(yield* read('/schedule')).toStrictEqual({ queued: 1 })
        const waitForIdle = read().pipe(Effect.flatMap((reply) => readIdle(reply, exact)))
        expect(yield* waitForIdle.pipe(Effect.retry(awaitAlarm))).toStrictEqual(idle)
      }).pipe(Effect.scoped),
    startupTimeout,
  )
})
