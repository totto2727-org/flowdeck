import { Effect, Layer } from 'effect'
import type { Scope } from 'effect'
import { HttpRouter } from 'effect/http'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { Workflows } from '@/core/feature/workflow/services/workflows'

import { ApiRoutes } from './router.ts'

type MakeRequest = (path: string, init?: RequestInit) => Effect.Effect<Response>

export const catalogPath = '/api/workflows'
export const runsPath = '/api/runs'
export const runId = 'run_00000000-0000-4000-8000-000000000001'
export const runPath = `${runsPath}/${runId}`
export const resumePath = `${runPath}/resume`
export const createBody = '{"workflowId":"demo","version":"1.0.0"}'
export const createRequest = { body: createBody, headers: { 'content-type': 'application/json' }, method: 'POST' }
export const post = { method: 'POST' }

export const unavailable = (): Effect.Effect<never, ExternalError> =>
  Effect.fail(
    new ExternalError({
      cause: 'Workflow integration worker unavailable',
      kind: 'service',
      operation: 'call workflow worker',
    }),
  )

export const unavailableWorkflows: Workflows['Service'] = {
  createRun: unavailable,
  getRunDetail: unavailable,
  listRuns: unavailable,
  listWorkflows: unavailable,
  resumeRun: unavailable,
}

export const openApi = (workflows: Workflows['Service']): Effect.Effect<MakeRequest, never, Scope.Scope> =>
  Effect.gen(function* () {
    const services = Layer.succeed(Workflows, workflows)
    const routes = ApiRoutes.pipe(HttpRouter.provideRequest(services))
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes)),
      (server) => Effect.promise(async () => server.dispose()),
    )
    return (path, init) =>
      Effect.promise(async () => handler.handler(new Request(new URL(path, 'http://localhost'), init)))
  })

export const responseJson = (response: Response): Effect.Effect<unknown> => Effect.promise(async () => response.json())
