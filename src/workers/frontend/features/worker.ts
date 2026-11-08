import { makeApplicationHttpEffect } from '@effront/alchemy/cloudflare'
import { Context, Effect } from 'effect'

/** Capture constructed application capabilities, not request bindings or host services. */
export const makeWebWorker = Effect.gen(function* () {
  const fetch = yield* makeApplicationHttpEffect(() => import('./entry.effront').then((module) => module.default))
  return { fetch }
})

export class WebWorker extends Context.Service<WebWorker, Effect.Success<typeof makeWebWorker>>()(
  'flowdeck/WebWorker',
) {}
