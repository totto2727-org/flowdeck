import { live } from '@effect/vitest'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import type { Scope } from 'effect'
import { Effect, Result, Schema } from 'effect'
import { HttpEffect } from 'effect/http'
import { describe, expect, expectTypeOf, vi } from 'vite-plus/test'

import { makeControl } from './control.ts'

const jsonResult = Schema.Result(Schema.Json, Schema.Json)
const reply = Schema.fromJsonString(Schema.toCodecJson(jsonResult))
const encodeReply = Schema.encodeEffect(reply)

const catalog = (name: string): Schema.Json => ({
  workflows: [{ inputs: [], name, versions: ['1.0.0'], workflowId: 'demo' }],
})

const rpcReply = Effect.fn('flowdeck.test.prepareWorkflowRpcReply')(function* (body: Schema.Json) {
  const wire = yield* encodeReply(Result.succeed(body))
  return vi.fn<() => Promise<string>>().mockResolvedValue(wire)
})

type WorkflowMethod = () => Promise<string>
type ControlFetch = Effect.Success<typeof makeControl>['fetch']
const withWorkflowBinding = (
  http: ControlFetch,
  listWorkflows: WorkflowMethod,
): ReturnType<typeof HttpEffect.toWebHandler> =>
  HttpEffect.toWebHandler(http.pipe(Effect.provideService(WorkerEnvironment, { WORKFLOW: { listWorkflows } })))

const request = (): Request => new Request('https://control.internal/api/workflows')

const observeCatalog = async (response: Response): Promise<Readonly<{ body: unknown; status: number }>> => ({
  body: await response.json(),
  status: response.status,
})

const queryBindings = Effect.fn('flowdeck.test.queryNativeWorkflowBindings')(function* (
  firstRpc: WorkflowMethod,
  secondRpc: WorkflowMethod,
) {
  const control = yield* makeControl
  const first = withWorkflowBinding(control.fetch, firstRpc)
  const second = withWorkflowBinding(control.fetch, secondRpc)
  return yield* Effect.promise(async () => {
    const [one, two, three] = await Promise.all([first(request()), second(request()), first(request())])
    return Promise.all([observeCatalog(one), observeCatalog(two), observeCatalog(three)])
  })
})

describe('control runtime initialization', () => {
  live(
    'constructs one reusable HTTP handler before request bindings exist and resolves each binding at call time',
    () =>
      Effect.gen(function* () {
        expectTypeOf<Effect.Services<typeof makeControl>>().toEqualTypeOf<Scope.Scope>()
        const firstCatalog = catalog('First binding')
        const secondCatalog = catalog('Second binding')
        const firstRpc = yield* rpcReply(firstCatalog)
        const secondRpc = yield* rpcReply(secondCatalog)
        const observed = yield* queryBindings(firstRpc, secondRpc).pipe(Effect.scoped)
        expect(observed).toStrictEqual([
          { body: firstCatalog, status: 200 },
          { body: secondCatalog, status: 200 },
          { body: firstCatalog, status: 200 },
        ])
        expect(firstRpc).toHaveBeenCalledTimes(2)
        expect(secondRpc).toHaveBeenCalledOnce()
      }),
  )
})
