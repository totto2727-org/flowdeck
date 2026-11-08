import type { HttpApplicationEffect } from '@effront/core/http'
import type { Effect, Scope } from 'effect'
import type { HttpServerRequest } from 'effect/http'
import { expectTypeOf, it } from 'vite-plus/test'

import type { ControlApi } from './control-api'
import type { makeWebWorker } from './worker'

type FrontendFetch = Effect.Success<typeof makeWebWorker>['fetch']

it('captures only ControlApi and leaves request scope and typed failures with the native host', () => {
  expectTypeOf<Effect.Services<typeof makeWebWorker>>().toEqualTypeOf<ControlApi>()
  expectTypeOf<Effect.Error<typeof makeWebWorker>>().toEqualTypeOf<never>()
  expectTypeOf<Effect.Services<FrontendFetch>>().toEqualTypeOf<HttpServerRequest.HttpServerRequest | Scope.Scope>()
  expectTypeOf<Effect.Error<FrontendFetch>>().toEqualTypeOf<Effect.Error<HttpApplicationEffect<never, ControlApi>>>()
})
