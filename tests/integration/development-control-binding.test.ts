import { live } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { HttpRouter } from 'effect/http'
import { expect } from 'vite-plus/test'

import { RunDetail } from '@/core/feature/workflow/domain/model'
import { ApiRoutes } from '@/core/worker/control/feature/router'

import { httpCreated, httpOk, runsPath } from './d1-workflow-http.fixture.ts'
import { workflowControlLayer } from './development-control-layer.fixture.ts'
import { openDevelopmentFixture } from './development-d1.fixture.ts'
import { developmentInput, rootOf } from './development-snapshot.fixture.ts'

const decodeRunDetail = Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(RunDetail)))
const runRequest = {
  ...developmentInput,
  repository: developmentInput.repository.href,
  version: '1.0.0',
}
const createRequest = {
  body: JSON.stringify(runRequest),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
} satisfies RequestInit

const openControl = Effect.gen(function* () {
  const development = yield* openDevelopmentFixture
  const routes = ApiRoutes.pipe(HttpRouter.provideRequest(workflowControlLayer(development)))
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes)),
    (listener) => Effect.promise(async () => listener.dispose()),
  )
  return {
    handle: (path: string, init: RequestInit): Effect.Effect<Response> =>
      Effect.promise(async () => handler(new Request(new URL(path, 'http://localhost'), init))),
    submissions: development.pi.read,
  }
})

const readRun = Effect.fn('flowdeck.test.decodeControlRun')(function* (response: Response) {
  const body = yield* Effect.promise(async () => response.text())
  const detail = yield* decodeRunDetail(body)
  return detail.run
})

live('routes create and read-only Resume through the static development binding', () =>
  Effect.gen(function* () {
    const control = yield* openControl
    const created = yield* control.handle(runsPath, createRequest)
    expect(created.status).toBe(httpCreated)
    const started = yield* readRun(created)
    expect(started).toMatchObject({
      status: 'waiting',
      workflowId: 'jcode-development',
      workflowVersion: developmentInput.version,
    })
    expect(yield* rootOf(started.snapshot)).toMatchObject({
      repository: developmentInput.repository,
      runtime: 'pi-harness',
      task: developmentInput.task,
    })
    const resumed = yield* control.handle(`${runsPath}/${started.runId}/resume`, { method: 'POST' })
    expect({ run: yield* readRun(resumed), status: resumed.status }).toStrictEqual({
      run: started,
      status: httpOk,
    })
    expect(control.submissions().submissions).toHaveLength(1)
  }).pipe(Effect.scoped),
)
