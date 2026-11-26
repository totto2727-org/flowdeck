import { live } from '@effect/vitest'
import { Array, Effect, MutableRef, Option, Result } from 'effect'
import { expect } from 'vite-plus/test'

import { collectRpcBoundary, requiredPrivateMarkers, presentMarkers } from './rpc-boundary-wire.fixture.ts'
import { compileRpcBoundary, openRpcBoundary } from './rpc-boundary.fixture.ts'

const source = MutableRef.make(Option.none<Promise<string>>())
const compiledBundle = async (): Promise<string> => {
  const existing = MutableRef.get(source)
  if (Option.isSome(existing)) {
    return existing.value
  }
  const fresh = compileRpcBoundary()
  MutableRef.set(source, Option.some(fresh))
  return fresh
}
const openBoundary = Effect.promise(compiledBundle).pipe(Effect.flatMap(openRpcBoundary))

const problemTypes = 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md'
const errorCases = [
  {
    externalError: true,
    problem: {
      detail: 'A persistence operation failed.',
      status: 500,
      title: 'storage',
      type: `${problemTypes}#storage`,
    },
    scenario: 'failure',
  },
  {
    externalError: false,
    problem: {
      detail: 'The requested resource was not found.',
      status: 404,
      title: 'not-found',
      type: `${problemTypes}#not-found`,
    },
    scenario: 'not-found',
  },
  {
    externalError: false,
    problem: {
      detail: 'The operation could not be completed.',
      status: 500,
      title: 'internal',
      type: `${problemTypes}#internal`,
    },
    scenario: 'defect',
  },
] as const

// oxlint-disable-next-line unicorn/no-null -- The known successful JSON reply includes an explicit null array entry.
const knownJsonNull = null
const knownReply = { answer: 42, values: [knownJsonNull, true, 'ok'] }
const failKeys = ['cause', 'stack']
const remoteErrorKind = 'RemoteWorkerError'

live('round-trips success across a real service binding without failure logs', () =>
  Effect.gen(function* () {
    const boundary = yield* openBoundary
    const { childLogs, parentLogs, reply, response } = yield* collectRpcBoundary(boundary, 'success')
    expect(response).toBeTypeOf('string')
    expect(Result.getOrThrow(reply)).toStrictEqual(knownReply)
    expect({ childLogs, parentLogs }).toStrictEqual({ childLogs: [], parentLogs: [] })
  }).pipe(Effect.scoped),
)

const observeFailure = Effect.fn('flowdeck.test.observeWorkerFailure')(function* (
  scenario: (typeof errorCases)[number]['scenario'],
) {
  const boundary = yield* openBoundary
  const { childLogs, parentLogs, reply, response } = yield* collectRpcBoundary(boundary, scenario)
  const publicProblem = Result.getOrThrow(Result.flip(reply))
  const childLog = Option.getOrThrow(Array.head(childLogs))
  const parentLog = Option.getOrThrow(Array.head(parentLogs))
  return { childLog, childLogs, parentLog, parentLogs, publicProblem, response }
})

live.each(errorCases)(
  'returns JSON text for a child $scenario and keeps private diagnostics in its originating isolate',
  ({ externalError, problem, scenario }) =>
    Effect.gen(function* () {
      const { childLog, childLogs, parentLog, parentLogs, publicProblem, response } = yield* observeFailure(scenario)
      expect({
        ...publicProblem,
        instance: typeof publicProblem.instance,
        response: typeof response,
      }).toStrictEqual({ ...problem, instance: 'string', response: 'string' })
      expect({
        childCount: Array.length(childLogs),
        externalError: childLog.externalError,
        operation: childLog.operation,
        parentCount: Array.length(parentLogs),
        privateMarkers: presentMarkers(requiredPrivateMarkers, JSON.stringify(childLog)),
        remoteError: childLog.remoteError,
      }).toStrictEqual({
        childCount: 1,
        externalError,
        operation: 'child.start',
        parentCount: 1,
        privateMarkers: requiredPrivateMarkers,
        remoteError: false,
      })
      expect(parentLog).toMatchObject({
        errorId: publicProblem.instance,
        externalError: false,
        operation: 'parent.start',
        originalStack: '',
        priorProblem: { ...publicProblem, instance: childLog.errorId },
        remoteError: true,
      })
      expect({
        distinctIds: parentLog.errorId !== childLog.errorId,
        linksOriginal: parentLog.renderedCause.includes(childLog.errorId),
        localRemoteError: parentLog.localStack.includes(remoteErrorKind),
        parentPrivateMarkers: presentMarkers(requiredPrivateMarkers, JSON.stringify(parentLog)),
      }).toStrictEqual({ distinctIds: true, linksOriginal: true, localRemoteError: true, parentPrivateMarkers: [] })
      expect({
        privateFields: Array.intersection(Object.keys(publicProblem), failKeys),
        publicPrivateMarkers: presentMarkers([...requiredPrivateMarkers, childLog.errorId, remoteErrorKind], response),
      }).toStrictEqual({ privateFields: [], publicPrivateMarkers: [] })
    }).pipe(Effect.scoped),
)
