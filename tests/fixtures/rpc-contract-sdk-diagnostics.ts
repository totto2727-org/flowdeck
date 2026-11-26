import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { ErrorTag } from 'alchemy/Rpc'
import { Array, Cause, Context, Data, Effect, Layer, Logger, Option } from 'effect'
import { HttpRouter } from 'effect/http'

import { rpcCall, RpcRunsResponse, rpcValue } from '@/core/feature/workflow/rpc/contract'
import type { WireWorkflowService } from '@/core/feature/workflow/rpc/contract'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { ApiRoutes } from '@/core/worker/control/feature/router'

export const originScenarios = ['SDK error envelope', 'rejected call', 'SDK defect'] as const
export type Scenario = (typeof originScenarios)[number]

const originError = (): Error => {
  // oxlint-disable-next-line rules/require-tagged-error -- The fixture tests sanitization of a native SDK failure and its original identity.
  const origin = new Error('PRIVATE_ORIGIN_MESSAGE', { cause: { password: 'PRIVATE_ORIGIN_SECRET' } })
  origin.stack = 'Error: PRIVATE_ORIGIN_MESSAGE\n at PRIVATE_ORIGIN_STACK (child.ts:1:1)'
  return origin
}

type Details = Readonly<{ cause: unknown; message: string; stack: string }>
type SdkOrigin = Data.TaggedEnum<{ ExternalError: Details }>
const originFailure = Data.taggedEnum<SdkOrigin>().ExternalError
const wire = Data.taggedEnum<Data.TaggedEnum<Record<typeof ErrorTag, { error: SdkOrigin }>>>()
const encodeOrigin = (origin: Error): ReturnType<(typeof wire)[typeof ErrorTag]> =>
  wire[ErrorTag]({
    error: originFailure({
      cause: origin.cause,
      message: origin.message,
      stack: origin.stack ?? '',
    }),
  })

type ListRuns = (typeof Workflows.Service)['listRuns']
type OriginCall = Readonly<{ listRuns: ListRuns; origin: Error }>

export const makeOriginCall = (scenario: Scenario): OriginCall => {
  const origin = originError()
  const envelope = encodeOrigin(origin)
  const peer = {
    listRuns: async () => (scenario === 'rejected call' ? Promise.reject(origin) : Promise.resolve(envelope)),
  }
  const sdk = makeRpcStub<WireWorkflowService>(scenario === 'SDK defect' ? Effect.die(origin) : Effect.succeed(peer))
  const decodeRuns = rpcValue('Workflow.listRuns', RpcRunsResponse)
  const listRuns: ListRuns = () => sdk.listRuns().pipe(rpcCall('Workflow.listRuns'), Effect.flatMap(decodeRuns))
  return { listRuns, origin }
}

const unused = (): Effect.Effect<never> => Effect.die('Unused regression operation')

const openRoutes = Effect.fn('flowdeck.test.openParentHttp')(function* (listRuns: ListRuns) {
  const workflows: typeof Workflows.Service = {
    createRun: unused,
    getRunDetail: unused,
    listRuns,
    listWorkflows: unused,
    resumeRun: unused,
  }
  const available = Layer.succeed(Workflows, workflows)
  const routes = ApiRoutes.pipe(HttpRouter.provideRequest(available))
  return yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes)),
    (handler) => Effect.promise(async () => handler.dispose()),
  )
})

export const observeParentHttp = Effect.fn('flowdeck.test.observeParentHttp')(function* (listRuns: ListRuns) {
  const entries: Logger.Options<unknown>[] = []
  const logger = Logger.make((entry) => {
    entries.push(entry)
  })
  const api = yield* openRoutes(listRuns)
  const context = Context.make(Logger.CurrentLoggers, new Set([logger]))
  const reply = yield* Effect.promise(async () => api.handler(new Request('http://localhost/api/runs'), context))
  const body = yield* Effect.promise(async () => reply.text())
  const log = Option.getOrThrow(Array.head(entries))
  const logged = Option.getOrThrow(Cause.findErrorOption(log.cause))
  return { body, entries, logged, pretty: Cause.pretty(log.cause), status: reply.status }
})
