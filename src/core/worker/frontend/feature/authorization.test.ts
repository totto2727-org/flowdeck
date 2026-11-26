import { Effect } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { describe, expect, test } from 'vite-plus/test'

import { AccessDenied } from '@/core/worker/frontend/access-auth'
import { HttpStatus } from '@/share/feature/http/status'

import { frontendAuthorization } from './authorization.ts'

describe('frontend HTTP authorization middleware', () => {
  const deniedStatuses = [HttpStatus.unauthorized, HttpStatus.forbidden, HttpStatus.serviceUnavailable] as const

  test.each(deniedStatuses)('returns %s without executing the application', async (status) => {
    const calls: string[] = []
    const application = Effect.sync(() => {
      calls.push('application')
      return HttpServerResponse.text('application')
    })
    const denied = new AccessDenied({ message: 'Access denied.', status })
    const authorize = frontendAuthorization(Effect.fail(denied))
    const handler = HttpEffect.toWebHandler(application.pipe(authorize))

    const response = await handler(new Request('https://flowdeck.example/'))
    expect(response.status).toBe(status)
    await expect(response.text()).resolves.toBe('Access denied.')
    expect(calls).toStrictEqual([])
  })

  test('passes an admitted request to the application without replacing its response', async () => {
    const acceptedStatus = 202
    const application = Effect.succeed(HttpServerResponse.text('application', { status: acceptedStatus }))
    const handler = HttpEffect.toWebHandler(application.pipe(frontendAuthorization(Effect.void)))

    const response = await handler(new Request('https://flowdeck.example/'))
    expect(response.status).toBe(acceptedStatus)
    await expect(response.text()).resolves.toBe('application')
  })
})
