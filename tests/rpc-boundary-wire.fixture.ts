import { Array, Effect, Schema } from 'effect'

import { Rfc9457ProblemDetailsSchema } from '@/core/feature/workflow/rpc/problem'

import type { Scenario } from './fixtures/rpc-boundary-worker.ts'
import type { openRpcBoundary } from './rpc-boundary.fixture.ts'

type Bindings = Effect.Success<ReturnType<typeof openRpcBoundary>>

const wireResult = Schema.Result(Schema.Json, Rfc9457ProblemDetailsSchema)
const resultJson = Schema.fromJsonString(Schema.toCodecJson(wireResult))
const decodeReply = Schema.decodeEffect(resultJson)

const Entry = Schema.Struct({
  errorId: Schema.String,
  externalError: Schema.Boolean,
  localStack: Schema.String,
  operation: Schema.String,
  originalStack: Schema.String,
  priorProblem: Schema.NullOr(Rfc9457ProblemDetailsSchema),
  remoteError: Schema.Boolean,
  renderedCause: Schema.String,
})
const logJson = Schema.fromJsonString(Schema.Array(Entry))
const decodeLogs = Schema.decodeEffect(logJson)

export const collectRpcBoundary = Effect.fn('flowdeck.test.readRpcBoundary')(function* (
  { child, parent }: Bindings,
  scenario: Scenario,
) {
  const response = yield* Effect.promise(async () => parent.start(scenario))
  const reply = yield* decodeReply(response, { onExcessProperty: 'error' })
  const parentJson = yield* Effect.promise(async () => parent.logs())
  const childJson = yield* Effect.promise(async () => child.logs())
  const parentLogs = yield* decodeLogs(parentJson)
  const childLogs = yield* decodeLogs(childJson)
  return { childLogs, parentLogs, reply, response }
})

export const requiredPrivateMarkers = ['PRIVATE_RPC_DATABASE_PASSWORD', 'childOnlyPrivateFrame']
export const presentMarkers = (markers: Readonly<string[]>, source: string): string[] =>
  Array.filter(markers, (marker) => source.includes(marker))
