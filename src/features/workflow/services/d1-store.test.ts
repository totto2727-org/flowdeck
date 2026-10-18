import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { BrowserCrypto } from '@effect/platform-browser'
import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { Array, Effect, Exit, Layer, Schema } from 'effect'
import { HttpRouter } from 'effect/http'
import { TestCrypto } from 'effect/testing'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ApiRoutes } from '../../../workers/control/features/router'
import { demoGraph, initialSnapshot, resumeRun, startRun } from '../../../workers/demo-workflow/features/demo'
import { createRun, makeWorkflows, resumeRun as resumeWorkflowRun } from '../../../workers/workflow/features/workflow'
import { DevelopmentWorkflowBinding, WorkflowBinding } from '../../../workers/workflow/features/workflow-binding'
import { BindingError, StoreError } from '../domain/errors'
import { RunDetail, type Run, type WorkflowVersion } from '../domain/model'
import { makeD1Store } from './d1-store'
import { type CommitCommand, Store, type StoreService } from './store'
import { Workflows } from './workflows'

const now = '2026-10-17T12:00:00.000Z'
const newRun = (runId: string, version: WorkflowVersion = 'v1'): Run => ({
  runId,
  workflowId: 'demo',
  workflowVersion: version,
  graphId: demoGraph(version).graphId,
  status: 'pending',
  revision: 0,
  snapshot: initialSnapshot(version),
  createdAt: now,
  updatedAt: now,
})
const command = (overrides: Partial<CommitCommand> = {}): CommitCommand => ({
  commitId: 'commit-1',
  runId: 'run-1',
  expectedRevision: 0,
  status: 'running',
  snapshot: { _tag: 'Preparing', schemaVersion: 1, version: 'v1', executionId: 'run-1:prepare:1', attempt: 1 },
  events: [
    {
      eventId: 'event-1',
      type: 'node.started',
      nodeId: 'prepare',
      executionId: 'run-1:prepare:1',
      attempt: 1,
      payload: {},
      createdAt: now,
    },
  ],
  updatedAt: now,
  ...overrides,
})

// Real local workerd D1, not a memory store or an imitation of SQL transactions.
let miniflare: Miniflare
let database: D1Database
let store: StoreService
beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default {}',
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'flowdeck-test' },
  })
  database = await miniflare.getD1Database('DB')
  const migrations = await readD1Migrations('migrations')
  await database.batch(
    Array.map(
      Array.flatMap(migrations, (migration) => migration.queries),
      (query) => database.prepare(query),
    ),
  )
  store = makeD1Store(database)
})
afterEach(async () => {
  await miniflare.dispose()
})
const run = <A, E>(effect: Effect.Effect<A, E, Store>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(Store, store)))
const seed = (runId = 'run-1', version: WorkflowVersion = 'v1') =>
  Effect.runPromise(store.create(newRun(runId, version), demoGraph(version)))

// A Layer substitutes only the static binding boundary. Its worker implementation
// is the same exported workflow used by the actual Durable Object adapter.
const testBinding = () =>
  Layer.succeed(WorkflowBinding, {
    start: (runId) => startRun(runId).pipe(Effect.provideService(Store, makeD1Store(database))),
    resume: (runId) => resumeRun(runId).pipe(Effect.provideService(Store, makeD1Store(database))),
  })
const unavailableDevelopmentBinding = Layer.succeed(DevelopmentWorkflowBinding, {
  start: () => Effect.fail(new BindingError({ cause: 'Development workflow not selected by this fixture' })),
  resume: () => Effect.fail(new BindingError({ cause: 'Development workflow not selected by this fixture' })),
})
const api = () =>
  HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      HttpRouter.provideRequest(
        Layer.effect(Workflows, makeWorkflows).pipe(
          Layer.provide(
            Layer.mergeAll(
              testBinding(),
              unavailableDevelopmentBinding,
              Layer.succeed(Store, store),
              TestCrypto.layer('flowdeck-api').pipe(Layer.provide(BrowserCrypto.layer)),
            ),
          ),
        ),
      ),
    ),
  )

describe('D1 persisted run store', () => {
  it('rejects duplicate event IDs inside a new commit without changing receipts, state or events', async () => {
    await seed()
    const firstEvent = Array.getUnsafe(command().events, 0)
    await expect(
      Effect.runPromise(
        store.commit(
          command({
            events: [firstEvent, { ...firstEvent, payload: { changed: true } }],
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'Conflict' })
    expect(await Effect.runPromise(store.getRun('run-1'))).toEqual(newRun('run-1'))
    expect(await Effect.runPromise(store.getEvents('run-1'))).toEqual([])
    expect(await Effect.runPromise(store.commit(command()))).toEqual({
      commitId: 'commit-1',
      runId: 'run-1',
      revision: 1,
      firstSequence: 1,
      eventCount: 1,
    })
  })

  it('persists run identity, graph and initial snapshot across store reconstruction', async () => {
    await seed()
    const restored = makeD1Store(database)
    expect(await Effect.runPromise(restored.getRun('run-1'))).toEqual(newRun('run-1'))
    expect(await Effect.runPromise(restored.getGraph(demoGraph('v1').graphId))).toEqual(demoGraph('v1'))
    expect(await Effect.runPromise(restored.listRuns)).toEqual([newRun('run-1')])
  })

  it('atomically commits snapshot revision and sequenced execution events before ACK', async () => {
    await seed()
    expect(await Effect.runPromise(store.commit(command()))).toEqual({
      commitId: 'commit-1',
      runId: 'run-1',
      revision: 1,
      firstSequence: 1,
      eventCount: 1,
    })
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({
      revision: 1,
      snapshot: command().snapshot,
      status: 'running',
    })
    expect(await Effect.runPromise(store.getEvents('run-1'))).toEqual([
      { ...Array.getUnsafe(command().events, 0), runId: 'run-1', sequence: 1 },
    ])
  })

  it('returns the original ACK for exact duplicate deliveries without advancing revision', async () => {
    await seed()
    const first = await Effect.runPromise(store.commit(command()))
    expect(await Effect.runPromise(store.commit(command()))).toEqual(first)
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({ revision: 1 })
    expect(await Effect.runPromise(store.getEvents('run-1'))).toHaveLength(1)
  })

  it('returns an old duplicate ACK after later commits without replaying its snapshot', async () => {
    await seed()
    const first = await Effect.runPromise(store.commit(command()))
    await Effect.runPromise(
      store.commit(
        command({
          commitId: 'commit-2',
          expectedRevision: 1,
          status: 'waiting',
          snapshot: { checkpoint: 'later' },
          events: [],
        }),
      ),
    )
    expect(await Effect.runPromise(store.commit(command()))).toEqual(first)
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({
      revision: 2,
      snapshot: { checkpoint: 'later' },
    })
  })

  it('rejects reuse of a commit ID with a different event payload', async () => {
    await seed()
    await Effect.runPromise(store.commit(command()))
    await expect(Effect.runPromise(store.commit(command({ snapshot: { altered: true } })))).rejects.toMatchObject({
      _tag: 'Conflict',
    })
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({ revision: 1, snapshot: command().snapshot })
  })

  it('allows exactly one concurrent compare-and-swap winner', async () => {
    await seed()
    const results = await Effect.runPromise(
      Effect.all(
        [
          store.commit(command()).pipe(Effect.exit),
          store.commit(command({ commitId: 'other-commit', events: [] })).pipe(Effect.exit),
        ],
        { concurrency: 'unbounded' },
      ),
    )
    expect(Array.filter(results, Exit.isSuccess)).toHaveLength(1)
    expect(Array.filter(results, Exit.isFailure)).toHaveLength(1)
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({ revision: 1 })
  })

  it('rolls back receipt, snapshot and all events when a later event violates uniqueness', async () => {
    await seed()
    await Effect.runPromise(store.commit(command()))
    const duplicate = Array.getUnsafe(command().events, 0)
    await expect(
      Effect.runPromise(
        store.commit(
          command({
            commitId: 'bad-commit',
            expectedRevision: 1,
            snapshot: { wrong: 'must roll back' },
            events: [{ ...duplicate, eventId: 'new-event' }, duplicate],
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'Conflict' })
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({ revision: 1, snapshot: command().snapshot })
    expect(await Effect.runPromise(store.getEvents('run-1'))).toHaveLength(1)
    // The rejected receipt must not reserve its ID or revision.
    expect(
      await Effect.runPromise(store.commit(command({ commitId: 'bad-commit', expectedRevision: 1, events: [] }))),
    ).toMatchObject({ revision: 2 })
  })

  it('prevents all fresh commits after a run becomes terminal but still ACKs exact duplicates', async () => {
    await seed()
    const terminal = command({ status: 'completed', snapshot: { done: true } })
    const ack = await Effect.runPromise(store.commit(terminal))
    await expect(
      Effect.runPromise(store.commit(command({ commitId: 'later', expectedRevision: 1, events: [] }))),
    ).rejects.toMatchObject({ _tag: 'Conflict' })
    expect(await Effect.runPromise(store.commit(terminal))).toEqual(ack)
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({ status: 'completed', revision: 1 })
  })

  it('bounds event reads to the revision used for a detail snapshot', async () => {
    await seed()
    await Effect.runPromise(store.commit(command()))
    await Effect.runPromise(
      store.commit(
        command({
          commitId: 'commit-2',
          expectedRevision: 1,
          events: Array.map(command().events, (event) => ({ ...event, eventId: 'event-2' })),
        }),
      ),
    )
    expect(await Effect.runPromise(store.getEvents('run-1', 1))).toHaveLength(1)
    expect(await Effect.runPromise(store.getEvents('run-1'))).toHaveLength(2)
  })

  it('rejects graph ID reuse with different immutable graph content', async () => {
    await seed()
    await expect(
      Effect.runPromise(store.create(newRun('run-2'), { ...demoGraph('v1'), nodes: [] })),
    ).rejects.toMatchObject({ _tag: 'Conflict' })
    expect(await Effect.runPromise(store.listRuns)).toHaveLength(1)
    expect(await Effect.runPromise(store.getGraph(demoGraph('v1').graphId))).toEqual(demoGraph('v1'))
  })
})

describe('demo cold restoration', () => {
  it.each(['v1', 'v2'] as const)(
    'restores the waiting %s version in a new service and completes only after explicit resume',
    async (version) => {
      await seed('run-1', version)
      await run(startRun('run-1'))
      const waiting = await Effect.runPromise(store.getRun('run-1'))
      expect(waiting).toMatchObject({
        status: 'waiting',
        revision: 2,
        workflowVersion: version,
        snapshot: { _tag: 'Waiting', version },
      })
      store = makeD1Store(database)
      await run(startRun('run-1'))
      expect(await Effect.runPromise(store.getRun('run-1'))).toEqual(waiting)
      await run(resumeRun('run-1'))
      const completed = await Effect.runPromise(store.getRun('run-1'))
      expect(completed).toMatchObject({
        status: 'completed',
        revision: 4,
        snapshot: {
          _tag: 'Completed',
          version,
          result: version === 'v1' ? 'published:draft:v1' : 'published:draft:v2:reviewed',
        },
      })
      const events = await Effect.runPromise(store.getEvents('run-1'))
      expect(Array.map(events, (event) => event.sequence)).toEqual(Array.range(1, 10))
      expect(Array.filter(events, (event) => event.nodeId === 'prepare' && event.type === 'node.started')).toHaveLength(
        1,
      )
      await expect(run(resumeRun('run-1'))).rejects.toMatchObject({ _tag: 'InvalidOperation' })
      expect(await Effect.runPromise(store.getRun('run-1'))).toEqual(completed)
    },
  )

  it('recovers a committed running prepare checkpoint without duplicating its start event', async () => {
    await seed()
    await Effect.runPromise(store.commit(command()))
    store = makeD1Store(database)
    await run(resumeRun('run-1'))
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({ status: 'waiting', revision: 2 })
    expect(
      Array.filter(
        await Effect.runPromise(store.getEvents('run-1')),
        (event) => event.type === 'node.started' && event.nodeId === 'prepare',
      ),
    ).toHaveLength(1)
  })

  it('rejects malformed or version-mismatched restored state before executing a node', async () => {
    await seed()
    await Effect.runPromise(store.commit(command({ snapshot: { _tag: 'Preparing', version: 'v9' } })))
    await expect(run(resumeRun('run-1'))).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
    expect(await Effect.runPromise(store.getEvents('run-1'))).toHaveLength(1)
  })
})

describe('interrupted workflow recovery', () => {
  it('rejects an unregistered persisted workflow before dispatch without changing its checkpoint', async () => {
    const unsupported = { ...newRun('unknown-run'), workflowId: 'unregistered-workflow' }
    await Effect.runPromise(store.create(unsupported, demoGraph('v1')))
    const resume = vi.fn(() => Effect.die('Unregistered workflows must not dispatch'))
    const binding = { start: resume, resume }
    await expect(
      Effect.runPromise(
        resumeWorkflowRun(unsupported.runId).pipe(
          Effect.provideService(Store, store),
          Effect.provideService(WorkflowBinding, binding),
          Effect.provideService(DevelopmentWorkflowBinding, binding),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'InvalidOperation', message: 'The persisted workflow is not registered' })
    expect(resume).not.toHaveBeenCalled()
    expect(await Effect.runPromise(store.getRun(unsupported.runId))).toEqual(unsupported)
    expect(await Effect.runPromise(store.getEvents(unsupported.runId))).toEqual([])
  })

  it('restores a running publish checkpoint without replaying manual approval or node start', async () => {
    await seed()
    await run(startRun('run-1'))
    const persisted = store
    const interrupted: StoreService = {
      ...persisted,
      commit: (input) =>
        input.status === 'completed'
          ? Effect.fail(new StoreError({ operation: 'injected checkpoint failure', cause: 'test interruption' }))
          : persisted.commit(input),
    }
    await expect(
      Effect.runPromise(resumeRun('run-1').pipe(Effect.provideService(Store, interrupted))),
    ).rejects.toMatchObject({ _tag: 'StoreError' })
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({
      revision: 3,
      status: 'running',
      snapshot: { _tag: 'Publishing', prepared: 'draft:v1' },
    })
    store = makeD1Store(database)
    await run(resumeRun('run-1'))
    const events = await Effect.runPromise(store.getEvents('run-1'))
    expect(Array.filter(events, (event) => event.nodeId === 'publish' && event.type === 'node.started')).toHaveLength(1)
    expect(
      Array.filter(events, (event) => event.nodeId === 'approval' && event.type === 'node.succeeded'),
    ).toHaveLength(1)
    expect(await Effect.runPromise(store.getRun('run-1'))).toMatchObject({ status: 'completed', revision: 4 })
    await expect(run(startRun('run-1'))).rejects.toMatchObject({ _tag: 'InvalidOperation' })
  })

  it('leaves a recoverable pending run if its native static workflow RPC rejects', async () => {
    // Promise rejection is the native service-binding boundary wrapped by the production Alchemy client.
    const binding = makeRpcStub<WorkflowBinding['Service']>({
      start: () => Promise.reject(new Error('Individual worker disconnected')),
    })
    await expect(
      Effect.runPromise(
        createRun({ workflowId: 'demo', version: 'v1' }).pipe(
          Effect.provideService(Store, store),
          Effect.provideService(WorkflowBinding, binding),
          Effect.provide(BrowserCrypto.layer),
          Effect.provide(unavailableDevelopmentBinding),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'BindingError' })
    const runs = await Effect.runPromise(store.listRuns)
    expect(runs).toHaveLength(1)
    const pending = Array.getUnsafe(runs, 0)
    expect(pending).toMatchObject({ status: 'pending', revision: 0 })
    await run(resumeRun(pending.runId))
    expect(await Effect.runPromise(store.getRun(pending.runId))).toMatchObject({ status: 'waiting', revision: 2 })
  })

  it('keeps the persisted checkpoint unchanged when an individual resume RPC rejects', async () => {
    await seed()
    await run(startRun('run-1'))
    const waiting = await Effect.runPromise(store.getRun('run-1'))
    const events = await Effect.runPromise(store.getEvents('run-1'))
    const binding = makeRpcStub<WorkflowBinding['Service']>({
      resume: () => Promise.reject(new Error('Individual worker disconnected')),
    })
    await expect(
      Effect.runPromise(
        resumeWorkflowRun('run-1').pipe(
          Effect.provideService(Store, store),
          Effect.provideService(WorkflowBinding, binding),
          Effect.provide(unavailableDevelopmentBinding),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'BindingError' })
    expect(await Effect.runPromise(store.getRun('run-1'))).toEqual(waiting)
    expect(await Effect.runPromise(store.getEvents('run-1'))).toEqual(events)
  })
})

describe('Effect HTTP API', () => {
  it('rejects browser-originated text/plain create requests without writing a run', async () => {
    const handler = api()
    try {
      const response = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
          body: '{"workflowId":"demo","version":"v1"}',
        }),
      )
      expect(response.status).toBe(403)
      expect(await Effect.runPromise(store.listRuns)).toEqual([])
    } finally {
      await handler.dispose()
    }
  })

  it('rejects browser-originated resume requests without advancing the persisted checkpoint', async () => {
    await seed()
    await run(startRun('run-1'))
    const waiting = await Effect.runPromise(store.getRun('run-1'))
    const events = await Effect.runPromise(store.getEvents('run-1'))
    const handler = api()
    try {
      const response = await handler.handler(
        new Request('http://localhost/api/runs/run-1/resume', {
          method: 'POST',
          headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
        }),
      )
      expect(response.status).toBe(403)
      expect(await Effect.runPromise(store.getRun('run-1'))).toEqual(waiting)
      expect(await Effect.runPromise(store.getEvents('run-1'))).toEqual(events)
    } finally {
      await handler.dispose()
    }
  })

  it('lists bundled workflows and validates the create boundary', async () => {
    const handler = api()
    try {
      const workflows = await handler.handler(new Request('http://localhost/api/workflows'))
      expect(workflows.status).toBe(200)
      expect(await workflows.json()).toEqual({
        workflows: [
          { workflowId: 'demo', name: 'Release checkpoint', versions: ['v1', 'v2'] },
          { workflowId: 'jcode-development', name: 'Pi development', versions: ['v1'] },
        ],
      })
      const invalid = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"workflowId":"demo","version":"v9"}',
        }),
      )
      expect(invalid.status).toBe(400)
      expect(await Effect.runPromise(store.listRuns)).toEqual([])
    } finally {
      await handler.dispose()
    }
  })

  it('creates, reads and resumes a persisted run, then protects the completed run', async () => {
    const handler = api()
    try {
      const created = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"workflowId":"demo","version":"v2"}',
        }),
      )
      expect(created.status).toBe(201)
      const body = await Effect.runPromise(Schema.decodeUnknownEffect(RunDetail)(await created.json()))
      expect(body.run.status).toBe('waiting')
      const detail = await handler.handler(new Request(`http://localhost/api/runs/${body.run.runId}`))
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({
        run: { status: 'waiting' },
        state: { revision: 2 },
        shapes: { nodes: [{ state: 'succeeded' }, { state: 'waiting' }, { state: 'idle' }] },
      })
      const listed = await handler.handler(new Request('http://localhost/api/runs'))
      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual({ runs: [body.run] })
      const resumed = await handler.handler(
        new Request(`http://localhost/api/runs/${body.run.runId}/resume`, { method: 'POST' }),
      )
      expect(resumed.status).toBe(200)
      expect(await resumed.json()).toMatchObject({
        run: { status: 'completed', workflowVersion: 'v2' },
        state: { revision: 4 },
      })
      const again = await handler.handler(
        new Request(`http://localhost/api/runs/${body.run.runId}/resume`, { method: 'POST' }),
      )
      expect(again.status).toBe(409)
    } finally {
      await handler.dispose()
    }
  })

  it('returns 404 for a missing persisted run', async () => {
    const handler = api()
    try {
      const response = await handler.handler(new Request('http://localhost/api/runs/absent'))
      expect(response.status).toBe(404)
    } finally {
      await handler.dispose()
    }
  })
})
