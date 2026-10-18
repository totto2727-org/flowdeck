import { JcodeClient } from '@1jehuang/jcode-sdk'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema, String } from 'effect'
import { HttpEffect } from 'effect/http'
import { describe, expect, it, vi } from 'vite-plus/test'

import { Gateway, GatewayError, launchSdk } from './sdk'
import { application } from './server'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const session = { sessionId: 'one', model: 'custom-opencode-go/deepseek-v4.1-flash', status: 'active' as const }
const fixture: Gateway['Service'] = {
  ensure: Effect.succeed(session),
  submit: (request) => Effect.succeed({ commandId: request.commandId, status: 'running' as const }),
  getTurn: () => Effect.fail(new GatewayError({ status: 404, code: 'turn_not_found' })),
  complete: Effect.succeed({ ...session, status: 'completed' as const }),
}

// Web Request/Response are used only by Effect's in-process HTTP test adapter.
const request = (url: string, body?: string) =>
  new Request(
    `http://container${url}`,
    body === undefined ? undefined : { method: 'POST', body, headers: { 'content-type': 'application/json' } },
  )

describe('container HTTP contract', () => {
  it('serves health, session, accepted turns, missing receipts and completion', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* application.pipe(Effect.provideService(Gateway, fixture))
          const handle = HttpEffect.toWebHandler(app)
          const health = yield* Effect.tryPromise(() => handle(request('/health')))
          expect(health.status).toBe(200)
          expect(yield* Effect.tryPromise(() => health.json())).toEqual({ status: 'ok' })
          const ensured = yield* Effect.tryPromise(() => handle(request('/session', '{}')))
          expect(yield* Effect.tryPromise(() => ensured.json())).toEqual(session)
          const accepted = yield* Effect.tryPromise(() =>
            handle(request('/turns', encodeJson({ commandId: 'run:implement:1', prompt: 'work' }))),
          )
          expect(accepted.status).toBe(202)
          expect(yield* Effect.tryPromise(() => accepted.json())).toEqual({
            commandId: 'run:implement:1',
            status: 'running',
          })
          const missing = yield* Effect.tryPromise(() => handle(request('/turns/absent')))
          expect(missing.status).toBe(404)
          expect(yield* Effect.tryPromise(() => missing.json())).toEqual({ error: 'turn_not_found' })
          const completed = yield* Effect.tryPromise(() => handle(request('/complete', '{}')))
          expect(yield* Effect.tryPromise(() => completed.json())).toEqual({ ...session, status: 'completed' })
        }),
      ),
    )
  })

  it.each([
    ['malformed JSON', '{'],
    ['empty prompt', '{"commandId":"one","prompt":""}'],
    ['unsafe command ID', '{"commandId":"../escape","prompt":"work"}'],
    ['oversized prompt', encodeJson({ commandId: 'one', prompt: String.repeat(32_769)('a') })],
  ])('rejects %s without submitting a turn', async (_name, body) => {
    const submit = vi.fn(fixture.submit)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* application.pipe(Effect.provideService(Gateway, { ...fixture, submit }))
          const response = yield* Effect.tryPromise(() => HttpEffect.toWebHandler(app)(request('/turns', body)))
          expect(response.status).toBe(400)
          expect(submit).not.toHaveBeenCalled()
        }),
      ),
    )
  })

  it.each(['/turns', '/session', '/complete'])('bounds request bytes at %s', async (url) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* application.pipe(Effect.provideService(Gateway, fixture))
          const response = yield* Effect.tryPromise(() =>
            HttpEffect.toWebHandler(app)(request(url, String.repeat(65_537)('a'))),
          )
          expect(response.status).toBe(413)
        }),
      ),
    )
  })

  it('returns only a sanitized error when the SDK rejects a requested model', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* application.pipe(
            Effect.provideService(Gateway, {
              ...fixture,
              ensure: Effect.fail(
                new GatewayError({ status: 503, code: 'sdk_unavailable', cause: new Error('secret-api-key') }),
              ),
            }),
          )
          const response = yield* Effect.tryPromise(() => HttpEffect.toWebHandler(app)(request('/session', '{}')))
          expect(response.status).toBe(503)
          expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: 'sdk_unavailable' })
        }),
      ),
    )
  })

  it('keeps the image HOME, launcher PATH and working directory under /home/sandbox', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dockerfile = yield* fs.readFileString('containers/jcode/Dockerfile')
        expect(String.split(dockerfile, '\n')).toEqual(
          expect.arrayContaining([
            'ARG JCODE_VERSION=v0.98.1',
            'ENV HOME=/home/sandbox',
            'ENV PATH=/home/sandbox/.local/bin:/home/sandbox/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin',
            'WORKDIR /home/sandbox/workspace',
          ]),
        )
        expect(dockerfile).toContain('JCODE_VERSION="${JCODE_VERSION}" JCODE_SKIP_SERVER_RELOAD=1 JCODE_NO_TELEMETRY=1')
      }).pipe(Effect.provide(NodeServices.layer)),
    )
  })

  it('uses the image HOME for SDK binary, configuration and workspace without inherited logins', async () => {
    const launch = vi.spyOn(JcodeClient, 'launch').mockRejectedValue(new Error('fixture: do not start a server'))
    try {
      await Effect.runPromise(Effect.scoped(launchSdk.pipe(Effect.result)))
      expect(launch).toHaveBeenCalledExactlyOnceWith({
        binary: '/home/sandbox/.local/bin/jcode',
        jcodeHome: '/home/sandbox/.jcode',
        workingDir: '/home/sandbox/workspace',
        inheritLogins: false,
        swarmModel: 'inherit',
        env: { HOME: '/home/sandbox', CLOUDFLARE_AI_GATEWAY_API_KEY: '' },
      })
    } finally {
      launch.mockRestore()
    }
  })
})
