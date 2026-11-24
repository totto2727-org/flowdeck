import { live } from '@effect/vitest'
import { Effect, Schema, SemVer } from 'effect'
import { describe, expect, vi } from 'vite-plus/test'

import { RunId } from '@/core/feature/workflow/domain/identity'
import { RunDetail, RunsResponse } from '@/core/feature/workflow/domain/model'
import { EventRange } from '@/core/feature/workflow/services/store'
import { startRun } from '@/user-land/workflow/demo/feature/demo'

import { d1Fixture } from './d1-workflows.fixture.ts'

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The native HTTP response body has no trusted shape.
const decodeHttpRunDetail = Schema.decodeUnknownEffect(Schema.toCodecJson(RunDetail))

describe('effect HTTP API', () => {
  live('rejects bare UUIDv4 run IDs at persistence and HTTP boundaries', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const id = '00000000-0000-4000-8000-000000000003'
      expect(yield* Effect.flip(fixture.seedEffect(id))).toMatchObject({ _tag: 'ExternalError' })
      expect(yield* fixture.store.listRuns).toStrictEqual([])
      const handler = fixture.api()
      try {
        const read = yield* Effect.promise(async () => handler.handler(new Request(`http://localhost/api/runs/${id}`)))
        expect(read.status).toBe(400)
        const resumed = yield* Effect.promise(async () =>
          handler.handler(new Request(`http://localhost/api/runs/${id}/resume`, { method: 'POST' })),
        )
        expect(resumed.status).toBe(400)
        expect(yield* fixture.store.listRuns).toStrictEqual([])
      } finally {
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )

  live('supports an arbitrary workflow through registry-only catalog, creation, detail and resume', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* Effect.tryPromise(async () => {
        const version = SemVer.parseUnsafe('3.4.5-beta.1+build.7')
        const summary = { workflowId: 'review-workflow', name: 'Review changes', versions: [version], inputs: [] }
        const graph = {
          graphId: 'review-workflow-3_4_5-beta_1-build_7-graph-1',
          schemaVersion: 1,
          nodes: [],
          edges: [],
        } as const
        const input = Schema.Struct({
          workflowId: Schema.Literal('review-workflow'),
          version: Schema.SemVer.check(Schema.makeFilter((value) => SemVer.equals(value, version))),
          topic: Schema.String,
        })
        const start = vi.fn((_runId: string) => Effect.void)
        const resume = vi.fn((_runId: string) => Effect.void)
        const persist = vi.spyOn(fixture.store, 'create')
        const handler = fixture.api([
          {
            summary,
            prepare: (value) =>
              Schema.decodeUnknownEffect(input)(value, { onExcessProperty: 'error' }).pipe(
                Effect.map((decoded) => ({ graph, snapshot: { topic: decoded.topic } })),
              ),
            binding: { start, resume },
          },
        ])
        try {
          const catalog = await handler.handler(new Request('http://localhost/api/workflows'))
          expect(catalog.status).toBe(200)
          await expect(catalog.json()).resolves.toStrictEqual({
            workflows: [{ ...summary, versions: [SemVer.format(version)] }],
          })
          const invalid = await handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ workflowId: summary.workflowId, version: '3.4.6', topic: 'Correctness' }),
            }),
          )
          expect(invalid.status).toBe(400)
          expect(persist).not.toHaveBeenCalled()
          expect(start).not.toHaveBeenCalled()
          const created = await handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workflowId: summary.workflowId,
                version: SemVer.format(version),
                topic: 'Correctness',
              }),
            }),
          )
          expect(created.status).toBe(201)
          const detail = Schema.decodeUnknownSync(Schema.toCodecJson(RunDetail))(await created.json())
          // Read the real D1 row at the adapter boundary, not the catalog or a mocked Store call.
          const workflowRow = await fixture.database
            .prepare('SELECT name FROM workflows WHERE workflow_id = ?')
            .bind(summary.workflowId)
            .first<{ name: string }>()
          expect(workflowRow).toStrictEqual({ name: summary.name })
          expect(detail.run).toMatchObject({
            workflowId: summary.workflowId,
            workflowVersion: version,
            graphId: graph.graphId,
            snapshot: { topic: 'Correctness' },
            revision: 0,
          })
          expect(start).toHaveBeenCalledExactlyOnceWith(detail.run.runId)
          const read = await handler.handler(new Request(`http://localhost/api/runs/${detail.run.runId}`))
          expect(read.status).toBe(200)
          await expect(read.json()).resolves.toStrictEqual(Schema.encodeSync(Schema.toCodecJson(RunDetail))(detail))
          const resumed = await handler.handler(
            new Request(`http://localhost/api/runs/${detail.run.runId}/resume`, { method: 'POST' }),
          )
          expect(resumed.status).toBe(200)
          await expect(resumed.json()).resolves.toStrictEqual(Schema.encodeSync(Schema.toCodecJson(RunDetail))(detail))
          expect(resume).toHaveBeenCalledExactlyOnceWith(detail.run.runId)
        } finally {
          persist.mockRestore()
          await handler.dispose()
        }
      })
    }),
  )

  live.each([
    { workflowId: 'demo', version: 'v1' },
    { workflowId: 'demo', version: '1.0.0', unexpected: true },
    {
      workflowId: 'jcode-development',
      version: '1.0.0',
      repository: 'https://github.com/example/project',
      task: 'Valid',
      unexpected: true,
    },
    { workflowId: 'jcode-development', version: '1.0.0', repository: 'https://evil.example/project', task: 'Valid' },
  ])('rejects invalid workflow-owned input before persistence: %j', (input) =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const create = vi.spyOn(fixture.store, 'create')
      const handler = fixture.api()
      try {
        const response = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
            }),
          ),
        )
        expect(response.status).toBe(400)
        expect(create).not.toHaveBeenCalled()
        expect(yield* fixture.store.listRuns).toStrictEqual([])
      } finally {
        create.mockRestore()
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )
  live('rejects browser-originated text/plain create requests without writing a run', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const handler = fixture.api()
      try {
        const response = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
              body: '{"workflowId":"demo","version":"v1"}',
            }),
          ),
        )
        expect(response.status).toBe(403)
        expect(yield* fixture.store.listRuns).toStrictEqual([])
      } finally {
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )

  live('rejects browser-originated resume requests without advancing the persisted checkpoint', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
      const waiting = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
      const events = yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())
      const handler = fixture.api()
      try {
        const response = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs/run_00000000-0000-4000-8000-000000000001/resume', {
              method: 'POST',
              headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
            }),
          ),
        )
        expect(response.status).toBe(403)
        expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(waiting)
        expect(
          yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All()),
        ).toStrictEqual(events)
      } finally {
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )

  live('lists bundled workflows and validates the create boundary', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const handler = fixture.api()
      try {
        const workflows = yield* Effect.promise(async () =>
          handler.handler(new Request('http://localhost/api/workflows')),
        )
        expect(workflows.status).toBe(200)
        yield* Effect.promise(async () =>
          expect(workflows.json()).resolves.toStrictEqual({
            workflows: [
              { inputs: [], name: 'Release checkpoint', versions: ['1.0.0', '2.0.0'], workflowId: 'demo' },
              expect.objectContaining({
                workflowId: 'jcode-development',
                name: 'Pi development',
                versions: ['1.0.0'],
                inputs: [
                  expect.objectContaining({
                    name: 'repository',
                    label: 'Public GitHub repository',
                    kind: 'text',
                    required: true,
                  }),
                  expect.objectContaining({
                    name: 'task',
                    label: 'Development task',
                    kind: 'textarea',
                    required: true,
                    maxLength: 16_000,
                  }),
                ],
              }),
            ],
          }),
        )
        const invalid = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{"workflowId":"demo","version":"v9"}',
            }),
          ),
        )
        expect(invalid.status).toBe(400)
        const unsafeId = yield* Effect.promise(async () =>
          handler.handler(
            new Request('http://localhost/api/runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ workflowId: '../demo', version: '1.0.0' }),
            }),
          ),
        )
        expect(unsafeId.status).toBe(400)
        expect(yield* fixture.store.listRuns).toStrictEqual([])
      } finally {
        yield* Effect.promise(async () => handler.dispose())
      }
    }),
  )

  live.each(['1.0.0', '2.0.0'])(
    'creates, reads and resumes a persisted %s run, then protects the completed run',
    (version) =>
      Effect.gen(function* () {
        const fixture = yield* d1Fixture
        const handler = fixture.api()
        try {
          const created = yield* Effect.promise(async () =>
            handler.handler(
              new Request('http://localhost/api/runs', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workflowId: 'demo', version }),
              }),
            ),
          )
          expect(created.status).toBe(201)
          const json: unknown = yield* Effect.promise(async () => created.json())
          const body = yield* decodeHttpRunDetail(json)
          expect(Schema.is(RunId)(body.run.runId)).toBe(true)
          expect(body.run.status).toBe('waiting')
          const detail = yield* Effect.promise(async () =>
            handler.handler(new Request(`http://localhost/api/runs/${body.run.runId}`)),
          )
          expect(detail.status).toBe(200)
          yield* Effect.promise(async () =>
            expect(detail.json()).resolves.toMatchObject({
              run: { status: 'waiting' },
              shapes: { nodes: [{ state: 'succeeded' }, { state: 'waiting' }, { state: 'idle' }] },
              state: { revision: 2 },
            }),
          )
          const listed = yield* Effect.promise(async () => handler.handler(new Request('http://localhost/api/runs')))
          expect(listed.status).toBe(200)
          yield* Effect.promise(async () =>
            expect(listed.json()).resolves.toStrictEqual(
              Schema.encodeSync(Schema.toCodecJson(RunsResponse))({ runs: [body.run] }),
            ),
          )
          const resumed = yield* Effect.promise(async () =>
            handler.handler(new Request(`http://localhost/api/runs/${body.run.runId}/resume`, { method: 'POST' })),
          )
          expect(resumed.status).toBe(200)
          yield* Effect.promise(async () =>
            expect(resumed.json()).resolves.toMatchObject({
              run: { status: 'completed', workflowVersion: version },
              state: { revision: 4 },
            }),
          )
          const again = yield* Effect.promise(async () =>
            handler.handler(new Request(`http://localhost/api/runs/${body.run.runId}/resume`, { method: 'POST' })),
          )
          expect(again.status).toBe(409)
        } finally {
          yield* Effect.promise(async () => handler.dispose())
        }
      }),
  )

  live('returns 404 for a missing persisted run', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* Effect.tryPromise(async () => {
        const handler = fixture.api()
        try {
          const response = await handler.handler(
            new Request('http://localhost/api/runs/run_00000000-0000-4000-8000-000000000005'),
          )
          expect(response.status).toBe(404)
        } finally {
          await handler.dispose()
        }
      })
    }),
  )
})
