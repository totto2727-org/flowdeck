import { makeApplicationHttpEffect } from '@effront/alchemy/cloudflare'
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { ControlApi, makeControlApi } from './control-api'

export interface ControlBinding {
  readonly fetch: (request: Request) => Promise<Response>
}

/** Native Request conversion is restricted to this external service-binding boundary. */
export const makeWebWorker = (control: ControlBinding) =>
  Effect.gen(function* () {
    const bindingFetch: typeof globalThis.fetch = (input, init) => control.fetch(new Request(input, init))
    const api = yield* makeControlApi.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, bindingFetch),
    )
    const application = yield* makeApplicationHttpEffect(() =>
      import('./entry.effront').then((module) => module.default),
    ).pipe(Effect.provideService(ControlApi, api))
    return { fetch: application }
  })
