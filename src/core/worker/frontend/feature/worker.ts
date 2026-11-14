import { makeApplicationHttpEffect } from '@effront/alchemy/cloudflare/application'
import { Context, Effect } from 'effect'

import type application from './entry.effront'

/** Capture constructed application capabilities, not request bindings or host services. */
export const makeWebWorker = Effect.gen(function* () {
  const fetch = yield* makeApplicationHttpEffect<typeof application>()
  return { fetch }
})

export class WebWorker extends Context.Service<WebWorker, Effect.Success<typeof makeWebWorker>>()(
  'flowdeck/WebWorker',
) {}
