import { Effect } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { describe, expect, test } from 'vite-plus/test'

import { AccessDenied } from '@/core/worker/frontend/access-auth'

import { frontendAuthorization } from './authorization.ts'

describe('frontend HTTP authorization middleware', () => {
  test.each([401, 403, 503] as const)('returns %s without executing the application', async (status) => {
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
    await expect(response.text()).resolves.toBe('Access denied.')
    expect(calls).toBe(0)
  })

  test('passes an admitted request to the application without replacing its response', async () => {
    const handler = HttpEffect.toWebHandler(
      Effect.succeed(HttpServerResponse.text('application', { status: 202 })).pipe(
        frontendAuthorization(Effect.succeed(undefined)),
      ),
    )

    const response = await handler(new Request('https://flowdeck.example/'))
    expect(response.status).toBe(202)
    await expect(response.text()).resolves.toBe('application')
  })
})
