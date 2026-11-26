import { Effect } from 'effect'

import type { d1Fixture } from './d1-workflows.fixture.ts'

type Fixture = Effect.Success<typeof d1Fixture>
type Registry = Parameters<Fixture['api']>

export const httpOk = 200
export const httpCreated = 201
export const httpBadRequest = 400
export const httpForbidden = 403
export const httpNotFound = 404
export const httpConflict = 409
export const runsPath = '/api/runs'
export const catalogPath = '/api/workflows'

export const openApi = Effect.fn('flowdeck.test.openWorkflowHttp')(function* (fixture: Fixture, ...registry: Registry) {
  const api = yield* Effect.acquireRelease(
    Effect.sync(() => fixture.api(...registry)),
    (handler) => Effect.promise(async () => handler.dispose()),
  )
  const request = (path: string, init?: RequestInit): Effect.Effect<Response> =>
    Effect.promise(async () => api.handler(new Request(new URL(path, 'http://localhost'), init)))
  const post = (path: string, body: unknown): Effect.Effect<Response> =>
    request(path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
  return { post, request }
})

export const responseJson = (response: Response): Effect.Effect<unknown> => Effect.promise(async () => response.json())
