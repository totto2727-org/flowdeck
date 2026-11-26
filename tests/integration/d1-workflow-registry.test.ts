import { live } from '@effect/vitest'
import { Effect, Schema, SemVer } from 'effect'
import { expect, vi } from 'vite-plus/test'

import { RunDetail } from '@/core/feature/workflow/domain/model'
import type { RegisteredWorkflow, WorkflowExecutor } from '@/core/feature/workflow/services/workflow-definition'

import {
  catalogPath,
  httpBadRequest,
  httpCreated,
  httpOk,
  openApi,
  responseJson,
  runsPath,
} from './d1-workflow-http.fixture.ts'
import { d1Fixture } from './d1-workflows.fixture.ts'

const version = SemVer.parseUnsafe('3.4.5-beta.1+build.7')
const reviewVersion = SemVer.format(version)
const workflowId = 'review-workflow'
const summary = { inputs: [], name: 'Review changes', versions: [version], workflowId }
const graph = {
  edges: [],
  graphId: 'review-workflow-3_4_5-beta_1-build_7-graph-1',
  nodes: [],
  schemaVersion: 1,
} as const
const input = Schema.Struct({
  topic: Schema.String,
  version: Schema.SemVer.check(Schema.makeFilter((value) => SemVer.equals(value, version))),
  workflowId: Schema.Literal(workflowId),
})
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The registered workflow validates its own input fields from the public request layer.
const decodeInput = Schema.decodeUnknownEffect(input)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The native reply has no trusted type.
const decodeDetail = Schema.decodeUnknownEffect(Schema.toCodecJson(RunDetail))
const encodeDetail = Schema.encodeEffect(Schema.toCodecJson(RunDetail))

const reviewFixture = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  const start = vi.fn<WorkflowExecutor['start']>(() => Effect.void)
  const resume = vi.fn<WorkflowExecutor['resume']>(() => Effect.void)
  const binding = { resume, start }
  const registered: RegisteredWorkflow = {
    binding,
    prepare: (value) =>
      decodeInput(value, { onExcessProperty: 'error' }).pipe(
        Effect.map((decoded) => ({ graph, snapshot: { topic: decoded.topic } })),
      ),
    summary,
  }
  const api = yield* openApi(fixture, [registered])
  return { api, binding, fixture }
})

live('lists the registered workflow with its prerelease version', () =>
  Effect.gen(function* () {
    const { api } = yield* reviewFixture
    const catalog = yield* api.request(catalogPath)
    expect([catalog.status, yield* responseJson(catalog)]).toStrictEqual([
      httpOk,
      { workflows: [{ ...summary, versions: [reviewVersion] }] },
    ])
  }),
)

live('rejects an unsupported registered workflow version before persistence or start', () =>
  Effect.gen(function* () {
    const { api, binding, fixture } = yield* reviewFixture
    const persist = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(fixture.store, 'create')),
      (spy) =>
        Effect.sync(() => {
          spy.mockRestore()
        }),
    )
    const invalid = yield* api.post(runsPath, { topic: 'Correctness', version: '3.4.6', workflowId })
    expect(invalid.status).toBe(httpBadRequest)
    expect(persist).not.toHaveBeenCalled()
    expect(binding.start).not.toHaveBeenCalled()
  }),
)

const createReview = Effect.gen(function* () {
  const fixture = yield* reviewFixture
  const created = yield* fixture.api.post(runsPath, { topic: 'Correctness', version: reviewVersion, workflowId })
  const detail = yield* responseJson(created).pipe(Effect.flatMap(decodeDetail))
  return { ...fixture, detail, status: created.status }
})

live('persists the registered workflow and reconstructs its HTTP detail', () =>
  Effect.gen(function* () {
    const { api, binding, detail, fixture, status } = yield* createReview
    expect(status).toBe(httpCreated)
    const statement = fixture.database.prepare('SELECT name FROM workflows WHERE workflow_id = ?')
    const workflow = yield* Effect.promise(async () => statement.bind(workflowId).first<{ name: string }>())
    expect(workflow).toStrictEqual({ name: summary.name })
    expect(detail.run).toMatchObject({
      graphId: graph.graphId,
      revision: 0,
      snapshot: { topic: 'Correctness' },
      workflowId,
      workflowVersion: version,
    })
    expect(binding.start).toHaveBeenCalledExactlyOnceWith(detail.run.runId)
    const read = yield* api.request(`${runsPath}/${detail.run.runId}`)
    const wire = yield* encodeDetail(detail)
    expect([read.status, yield* responseJson(read)]).toStrictEqual([httpOk, wire])
  }),
)

live('resumes the registered workflow through its own binding', () =>
  Effect.gen(function* () {
    const { api, binding, detail } = yield* createReview
    const resumed = yield* api.request(`${runsPath}/${detail.run.runId}/resume`, { method: 'POST' })
    const wire = yield* encodeDetail(detail)
    expect([resumed.status, yield* responseJson(resumed)]).toStrictEqual([httpOk, wire])
    expect(binding.resume).toHaveBeenCalledExactlyOnceWith(detail.run.runId)
  }),
)
