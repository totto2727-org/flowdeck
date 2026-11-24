import { live } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect, vi } from 'vite-plus/test'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { RunId } from '@/core/feature/workflow/domain/identity'
import { RunDetail, RunsResponse } from '@/core/feature/workflow/domain/model'
import { EventRange } from '@/core/feature/workflow/services/store'
import { startRun } from '@/user-land/workflow/demo/feature/demo'

import {
  catalogPath,
  httpBadRequest,
  httpConflict,
  httpCreated,
  httpForbidden,
  httpNotFound,
  httpOk,
  openApi,
  responseJson,
  runsPath,
} from './d1-workflow-http.fixture.ts'
import { d1Fixture } from './d1-workflows.fixture.ts'

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The native HTTP response body has no trusted shape.
const decodeHttpRunDetail = Schema.decodeUnknownEffect(Schema.toCodecJson(RunDetail))
const encodeRunList = Schema.encodeEffect(Schema.toCodecJson(RunsResponse))
const isRunId = Schema.is(RunId)
const fixtureRunId = 'run_00000000-0000-4000-8000-000000000001'
const restoreVersions = ['1.0.0', '2.0.0'] as const
const textOrigin = { 'content-type': 'text/plain', origin: 'https://evil.example' }

live('rejects bare UUIDv4 run IDs at persistence and HTTP boundaries', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const id = '00000000-0000-4000-8000-000000000003'
    const failure = yield* Effect.flip(fixture.seedEffect(id))
    expect(failure).toBeInstanceOf(ExternalError)
    expect(yield* fixture.store.listRuns).toStrictEqual([])
    const api = yield* openApi(fixture)
    const read = yield* api.request(`${runsPath}/${id}`)
    const resumed = yield* api.request(`${runsPath}/${id}/resume`, { method: 'POST' })
    expect([read.status, resumed.status]).toStrictEqual([httpBadRequest, httpBadRequest])
    expect(yield* fixture.store.listRuns).toStrictEqual([])
  }),
)

live.each([
  { version: 'v1', workflowId: 'demo' },
  { unexpected: true, version: '1.0.0', workflowId: 'demo' },
  {
    repository: 'https://github.com/example/project',
    task: 'Valid',
    unexpected: true,
    version: '1.0.0',
    workflowId: 'jcode-development',
  },
  { repository: 'https://evil.example/project', task: 'Valid', version: '1.0.0', workflowId: 'jcode-development' },
])('rejects invalid workflow-owned input before persistence: %j', (input) =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const create = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(fixture.store, 'create')),
      (spy) =>
        Effect.sync(() => {
          spy.mockRestore()
        }),
    )
    const api = yield* openApi(fixture)
    const response = yield* api.post(runsPath, input)
    expect(response.status).toBe(httpBadRequest)
    expect(create).not.toHaveBeenCalled()
    expect(yield* fixture.store.listRuns).toStrictEqual([])
  }),
)

live('rejects browser-originated text/plain create requests without writing a run', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const api = yield* openApi(fixture)
    const response = yield* api.request(runsPath, {
      body: '{"workflowId":"demo","version":"v1"}',
      headers: textOrigin,
      method: 'POST',
    })
    expect(response.status).toBe(httpForbidden)
    expect(yield* fixture.store.listRuns).toStrictEqual([])
  }),
)

live('rejects browser-originated resume requests without advancing the persisted checkpoint', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect()
    yield* fixture.provideTestServices(startRun(fixtureRunId))
    const checkpoint = Effect.all({
      events: fixture.store.getEvents(fixtureRunId, EventRange.All()),
      run: fixture.store.getRun(fixtureRunId),
    })
    const waiting = yield* checkpoint
    const api = yield* openApi(fixture)
    const response = yield* api.request(`${runsPath}/${fixtureRunId}/resume`, { headers: textOrigin, method: 'POST' })
    expect(response.status).toBe(httpForbidden)
    expect(yield* checkpoint).toStrictEqual(waiting)
  }),
)

live('lists bundled workflows with the required development inputs', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const api = yield* openApi(fixture)
    const workflows = yield* api.request(catalogPath)
    expect(workflows.status).toBe(httpOk)
    const body = yield* responseJson(workflows)
    expect(body).toMatchObject({
      workflows: [
        { inputs: [], name: 'Release checkpoint', versions: restoreVersions, workflowId: 'demo' },
        {
          inputs: [
            { kind: 'text', label: 'Public GitHub repository', name: 'repository', required: true },
            { kind: 'textarea', label: 'Development task', maxLength: 16_000, name: 'task', required: true },
          ],
          name: 'Pi development',
          versions: ['1.0.0'],
          workflowId: 'jcode-development',
        },
      ],
    })
  }),
)

live.each([
  { version: 'v9', workflowId: 'demo' },
  { version: '1.0.0', workflowId: '../demo' },
])('rejects invalid catalog identities at the public create endpoint: %j', (input) =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const api = yield* openApi(fixture)
    const response = yield* api.post(runsPath, input)
    expect(response.status).toBe(httpBadRequest)
    expect(yield* fixture.store.listRuns).toStrictEqual([])
  }),
)

const createDemo = Effect.fn('flowdeck.test.createHttpDemo')(function* (version: (typeof restoreVersions)[number]) {
  const fixture = yield* d1Fixture
  const api = yield* openApi(fixture)
  const response = yield* api.post(runsPath, { version, workflowId: 'demo' })
  const body = yield* responseJson(response)
  const detail = yield* decodeHttpRunDetail(body)
  return { api, detail, status: response.status }
})

live.each(restoreVersions)('creates, reads and lists a persisted %s run', (version) =>
  Effect.gen(function* () {
    const { api, detail, status } = yield* createDemo(version)
    expect([status, isRunId(detail.run.runId), detail.run.status]).toStrictEqual([httpCreated, true, 'waiting'])
    const run = yield* api.request(`${runsPath}/${detail.run.runId}`)
    expect([run.status, yield* responseJson(run)]).toMatchObject([
      httpOk,
      {
        run: { status: 'waiting' },
        shapes: { nodes: [{ state: 'succeeded' }, { state: 'waiting' }, { state: 'idle' }] },
        state: { revision: 2 },
      },
    ])
    const listed = yield* api.request(runsPath)
    const wire = yield* encodeRunList({ runs: [detail.run] })
    expect([listed.status, yield* responseJson(listed)]).toStrictEqual([httpOk, wire])
  }),
)

live.each(restoreVersions)('resumes a persisted %s run and protects its terminal checkpoint', (version) =>
  Effect.gen(function* () {
    const { api, detail } = yield* createDemo(version)
    const path = `${runsPath}/${detail.run.runId}/resume`
    const resumed = yield* api.request(path, { method: 'POST' })
    expect([resumed.status, yield* responseJson(resumed)]).toMatchObject([
      httpOk,
      { run: { status: 'completed', workflowVersion: version }, state: { revision: 4 } },
    ])
    const replay = yield* api.request(path, { method: 'POST' })
    expect(replay.status).toBe(httpConflict)
  }),
)

live('returns 404 for a missing persisted run', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const api = yield* openApi(fixture)
    const response = yield* api.request(`${runsPath}/run_00000000-0000-4000-8000-000000000005`)
    expect(response.status).toBe(httpNotFound)
  }),
)
