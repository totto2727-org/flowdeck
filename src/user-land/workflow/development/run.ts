import { QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import type { DurableObjectState } from 'alchemy/Cloudflare/Workers'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Context, Effect, Layer } from 'effect'

import { PiRun } from '@/core/worker/pi/run'

import { exposeDevelopmentCommands } from './run-commands.ts'
import { makeDevelopmentRunRuntime } from './run-runtime.ts'

export const DevelopmentRunLive = PiRun.make(
  Effect.gen(function* () {
    const runtime = yield* makeDevelopmentRunRuntime
    return Effect.gen(function* () {
      // Build one service graph per activation and reuse it for native callbacks.
      const ambient = yield* Effect.context<DurableObjectState | RuntimeContext>()
      const services = yield* Layer.build(runtime)
      const context = Context.merge(ambient, services)
      return yield* exposeDevelopmentCommands(services, context)
    })
  }).pipe(Effect.provide(QueryDatabaseBinding)),
)
