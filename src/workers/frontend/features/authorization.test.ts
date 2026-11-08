import { Effect } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { describe, expect, it } from 'vite-plus/test'

import { AccessDenied } from '@/workers/frontend/access-auth'

import { frontendAuthorization } from './authorization'

describe('frontend HTTP authorization middleware', () => {
  it.each([401, 403, 503] as const)('returns %s without executing the application', async (status) => {
    let calls = 0
    const application = Effect.sync(() => {
      calls += 1
      return HttpServerResponse.text('application')
    })
    const handler = HttpEffect.toWebHandler(
      application.pipe(frontendAuthorization(Effect.fail(new AccessDenied({ status, message: 'Access denied.' })))),
    )

    const response = await handler(new Request('https://flowdeck.example/'))
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('Access denied.')
    expect(calls).toBe(0)
  })

  it('passes an admitted request to the application without replacing its response', async () => {
    const handler = HttpEffect.toWebHandler(
      Effect.succeed(HttpServerResponse.text('application', { status: 202 })).pipe(
        frontendAuthorization(Effect.succeed(undefined)),
      ),
    )

    const response = await handler(new Request('https://flowdeck.example/'))
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('application')
  })
})
