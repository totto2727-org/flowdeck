import { live } from '@effect/vitest'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Result, Schema, Scope } from 'effect'
import { HttpEffect } from 'effect/http'
import { describe, expect, expectTypeOf, vi } from 'vite-plus/test'

import { makeControl } from './control.ts'

const encodeReply = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(Schema.Result(Schema.Json, Schema.Json))),
)
const catalog = (name: string) => ({
  workflows: [{ workflowId: 'demo', name, versions: ['1.0.0'], inputs: [] }],
})

describe('Control runtime initialization', () => {
  live(
    'constructs one reusable HTTP handler before request bindings exist and resolves each binding at call time',
    () =>
      Effect.gen(function* () {
        expectTypeOf<Effect.Services<typeof makeControl>>().toEqualTypeOf<Scope.Scope>()
        const firstRpc = vi.fn(async () => encodeReply(Result.succeed(catalog('First binding'))))
        const secondRpc = vi.fn(async () => encodeReply(Result.succeed(catalog('Second binding'))))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const control = yield* makeControl
            const first = HttpEffect.toWebHandler(
              control.fetch.pipe(Effect.provideService(WorkerEnvironment, { WORKFLOW: { listWorkflows: firstRpc } })),
            )
            const second = HttpEffect.toWebHandler(
              control.fetch.pipe(Effect.provideService(WorkerEnvironment, { WORKFLOW: { listWorkflows: secondRpc } })),
            )
            yield* Effect.promise(async () => {
              const [firstResponse, secondResponse, firstAgain] = await Promise.all([
                first(new Request('https://control.internal/api/workflows')),
                second(new Request('https://control.internal/api/workflows')),
                first(new Request('https://control.internal/api/workflows')),
              ])
              expect(firstResponse.status).toBe(200)
              expect(secondResponse.status).toBe(200)
              expect(firstAgain.status).toBe(200)
              await expect(firstResponse.json()).resolves.toStrictEqual(catalog('First binding'))
              await expect(secondResponse.json()).resolves.toStrictEqual(catalog('Second binding'))
              await expect(firstAgain.json()).resolves.toStrictEqual(catalog('First binding'))
            })
          }),
        )
        expect(firstRpc).toHaveBeenCalledTimes(2)
        expect(secondRpc).toHaveBeenCalledTimes(1)
      }),
  )
})
