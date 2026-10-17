import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { BrowserCrypto } from '@effect/platform-browser'
import { Array, Effect, Layer, Schema } from 'effect'
import { HttpRouter } from 'effect/http'
import { TestCrypto } from 'effect/testing'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import type { Session, TurnReceipt, TurnRequest } from '../../../features/jcode/model'
import { BindingError, StoreError } from '../../../features/workflow/domain/errors'
import { CreateRun, RunDetail, type Run } from '../../../features/workflow/domain/model'
import { makeD1Store } from '../../../features/workflow/services/d1-store'
import { Store, type StoreService } from '../../../features/workflow/services/store'
import { ApiRoutes } from '../../control/features/router'
import { DevelopmentWorkflowBinding, WorkflowBinding } from '../../control/features/workflow-binding'
import {
  DevelopmentSnapshot,
  developmentGraph,
  initialDevelopmentSnapshot,
  restoreDevelopment,
  resumeDevelopmentRun,
  startDevelopmentRun,
} from './development'
import { JcodeSandbox } from './sandbox'

const input = {
  workflowId: 'jcode-development',
  version: 'v1',
  repository: 'https://github.com/example/project',
  task: 'Add a greeting and test it.',
} as const
const timestamp = '2026-10-17T12:00:00.000Z'
const initialRun: Run = {
  runId: 'development-1',
  workflowId: input.workflowId,
  workflowVersion: 'v1',
  graphId: developmentGraph.graphId,
  status: 'pending',
  revision: 0,
  snapshot: initialDevelopmentSnapshot(input),
  createdAt: timestamp,
  updatedAt: timestamp,
}
let miniflare: Miniflare
let database: D1Database
let store: StoreService
let receipts: Record<string, TurnReceipt>
let submissions: ReadonlyArray<{ readonly runId: string; readonly input: TurnRequest }>
let session: Session
let completeCalls: ReadonlyArray<string>
let sandbox: JcodeSandbox['Service']
beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default {}',
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'development-test' },
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
  await Effect.runPromise(store.create(initialRun, developmentGraph))
  receipts = {}
  submissions = []
  completeCalls = []
  session = { sessionId: 'sdk-session-1', model: 'test-model', status: 'active' }
  sandbox = {
    ensureSession: () => Effect.sync(() => session),
    getTurn: (_runId, commandId) => Effect.sync(() => receipts[commandId] ?? null),
    submitTurn: (runId, request) =>
      Effect.gen(function* () {
        const current = yield* store.getRun(runId)
        expect(current.snapshot).toMatchObject({
          _tag: 'PendingTurn',
          commandId: request.commandId,
          sessionId: session.sessionId,
        })
        submissions = Array.append(submissions, { runId, input: request })
        const receipt = { commandId: request.commandId, status: 'running' } as const
        receipts = { ...receipts, [request.commandId]: receipt }
        return receipt
      }).pipe(Effect.mapError((cause) => new BindingError({ cause }))),
    complete: (runId) =>
      Effect.sync(() => {
        completeCalls = Array.append(completeCalls, runId)
        session = { ...session, status: 'completed' }
        return session
      }),
  }
})
afterEach(async () => {
  await miniflare.dispose()
})
const execute = <A, E>(effect: Effect.Effect<A, E, Store | JcodeSandbox>, suppliedStore = makeD1Store(database)) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(Store, suppliedStore), Effect.provideService(JcodeSandbox, sandbox)),
  )
const current = () => Effect.runPromise(makeD1Store(database).getRun(initialRun.runId))
const start = () => execute(startDevelopmentRun(initialRun.runId))
const resume = () => execute(resumeDevelopmentRun(initialRun.runId))
const finishTurn = (node: 'implement' | 'verify') => {
  const commandId = `${initialRun.runId}:${node}:1`
  receipts = { ...receipts, [commandId]: { commandId, status: 'completed', text: `${node} result` } }
}

describe('development workflow with canonical D1 checkpoints', () => {
  it('routes create and resume through the distinct static development binding', async () => {
    const provide = <A, E>(effect: Effect.Effect<A, E, Store | JcodeSandbox>) =>
      effect.pipe(Effect.provideService(Store, makeD1Store(database)), Effect.provideService(JcodeSandbox, sandbox))
    const handler = HttpRouter.toWebHandler(
      ApiRoutes.pipe(
        HttpRouter.provideRequest(
          Layer.mergeAll(
            Layer.succeed(Store, store),
            Layer.succeed(DevelopmentWorkflowBinding, {
              start: (runId) => provide(startDevelopmentRun(runId)),
              resume: (runId) => provide(resumeDevelopmentRun(runId)),
            }),
            Layer.succeed(WorkflowBinding, {
              start: () => Effect.fail(new BindingError({ cause: 'Wrong workflow binding' })),
              resume: () => Effect.fail(new BindingError({ cause: 'Wrong workflow binding' })),
            }),
            TestCrypto.layer('development-api').pipe(Layer.provide(BrowserCrypto.layer)),
          ),
        ),
      ),
    )
    try {
      // Native requests are the test adapter for the same Effect HTTP router used by Control.
      const response = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
      expect(response.status).toBe(201)
      const detail = Schema.decodeUnknownSync(RunDetail)(await response.json())
      expect(detail.run).toMatchObject({
        workflowId: 'jcode-development',
        workflowVersion: 'v1',
        status: 'waiting',
        snapshot: { repository: input.repository, task: input.task },
      })
      const resumed = await handler.handler(
        new Request(`http://localhost/api/runs/${detail.run.runId}/resume`, { method: 'POST' }),
      )
      expect(resumed.status).toBe(200)
      expect(Schema.decodeUnknownSync(RunDetail)(await resumed.json()).run).toEqual(detail.run)
      expect(submissions).toHaveLength(1)
    } finally {
      await handler.dispose()
    }
  })
  it('persists repository, task, pinned version and immutable graph before starting', async () => {
    expect(await current()).toEqual(initialRun)
    expect(await Effect.runPromise(store.getGraph(initialRun.graphId))).toEqual(developmentGraph)
  })
  it('commits command identity before accepting a long-running implementation turn', async () => {
    await start()
    expect(await current()).toMatchObject({
      status: 'waiting',
      snapshot: {
        _tag: 'AwaitingTurn',
        commandId: 'development-1:implement:1',
        sessionId: 'sdk-session-1',
        repository: input.repository,
        task: input.task,
      },
    })
    expect(submissions).toEqual([
      {
        runId: 'development-1',
        input: {
          commandId: 'development-1:implement:1',
          prompt: expect.stringContaining('/sandbox/workspace/project'),
        },
      },
    ])
    expect(submissions[0]?.input.prompt).toContain(input.repository)
    expect(submissions[0]?.input.prompt).toContain(input.task)
    expect(submissions[0]?.input.prompt).not.toContain('into /workspace/project')
    expect(Array.map(await Effect.runPromise(store.getEvents(initialRun.runId)), (event) => event.type)).toEqual([
      'run.started',
      'node.started',
      'run.waiting',
    ])
  })
  it('polls a running turn without changing checkpoints, events or submitting again', async () => {
    await start()
    const before = await current()
    const events = await Effect.runPromise(store.getEvents(initialRun.runId))
    await resume()
    expect(await current()).toEqual(before)
    expect(await Effect.runPromise(store.getEvents(initialRun.runId))).toEqual(events)
    expect(submissions).toHaveLength(1)
  })
  it('ignores repeated start delivery while a turn awaits explicit resume', async () => {
    await start()
    finishTurn('implement')
    await start()
    expect(submissions).toHaveLength(1)
    expect(await current()).toMatchObject({ snapshot: { nodeId: 'implement' } })
  })
  it('reconstructs runtime from D1 and submits verification in the same run and SDK session', async () => {
    await start()
    finishTurn('implement')
    await resume()
    expect(await current()).toMatchObject({
      status: 'waiting',
      snapshot: {
        _tag: 'AwaitingTurn',
        nodeId: 'verify',
        commandId: 'development-1:verify:1',
        sessionId: 'sdk-session-1',
      },
    })
    expect(submissions).toHaveLength(2)
    expect(submissions[1]).toEqual({
      runId: initialRun.runId,
      input: {
        commandId: 'development-1:verify:1',
        prompt: expect.stringContaining('same /sandbox/workspace/project'),
      },
    })
    expect(submissions[1]?.input.prompt).not.toContain('same /workspace/project')
    expect(completeCalls).toEqual([])
  })
  it('marks session and run complete only after verification finishes, without container destruction', async () => {
    await start()
    finishTurn('implement')
    await resume()
    finishTurn('verify')
    await resume()
    expect(await current()).toMatchObject({
      status: 'completed',
      snapshot: { _tag: 'Completed', sessionId: 'sdk-session-1', result: 'verify result' },
    })
    expect(completeCalls).toEqual([initialRun.runId])
    expect(Array.map(await Effect.runPromise(store.getEvents(initialRun.runId)), (event) => event.type)).toEqual([
      'run.started',
      'node.started',
      'run.waiting',
      'node.succeeded',
      'run.resumed',
      'node.started',
      'run.waiting',
      'run.resumed',
      'node.succeeded',
      'run.completed',
    ])
    await expect(resume()).rejects.toMatchObject({ _tag: 'InvalidOperation' })
  })
  it.each(['failed', 'interrupted'] as const)(
    'atomically reports a %s receipt and retains its container for inspection',
    async (status) => {
      await start()
      receipts = {
        'development-1:implement:1': {
          commandId: 'development-1:implement:1',
          status,
          error: status === 'failed' ? 'sdk_failure' : 'runtime_interrupted',
        },
      }
      await resume()
      expect(await current()).toMatchObject({ status: 'failed', snapshot: { _tag: 'Failed', nodeId: 'implement' } })
      const events = await Effect.runPromise(store.getEvents(initialRun.runId))
      expect(Array.map(Array.takeRight(events, 2), (event) => event.type)).toEqual(['node.failed', 'run.failed'])
      expect(submissions).toHaveLength(1)
      expect(completeCalls).toEqual([])
    },
  )
  it('never resubmits an acknowledged turn whose receipt later disappears', async () => {
    await start()
    receipts = {}
    await resume()
    expect(await current()).toMatchObject({
      status: 'failed',
      snapshot: { message: expect.stringContaining('will not be resubmitted') },
    })
    expect(submissions).toHaveLength(1)
  })
  it('recovers an accepted turn after its awaiting-checkpoint write fails without another SDK submission', async () => {
    const failing: StoreService = {
      ...store,
      commit: (command) =>
        Schema.is(DevelopmentSnapshot)(command.snapshot) && command.snapshot._tag === 'AwaitingTurn'
          ? Effect.fail(new StoreError({ operation: 'test checkpoint failure', cause: 'unavailable' }))
          : store.commit(command),
    }
    await expect(execute(startDevelopmentRun(initialRun.runId), failing)).rejects.toMatchObject({ _tag: 'StoreError' })
    expect(await current()).toMatchObject({
      status: 'running',
      snapshot: { _tag: 'PendingTurn', commandId: 'development-1:implement:1' },
    })
    await resume()
    expect(await current()).toMatchObject({ status: 'waiting', snapshot: { _tag: 'AwaitingTurn' } })
    expect(submissions).toHaveLength(1)
    expect(
      Array.filter(
        await Effect.runPromise(store.getEvents(initialRun.runId)),
        (event) => event.type === 'node.started',
      ),
    ).toHaveLength(1)
  })
  it('recovers startup after session creation transport failure with one stable command', async () => {
    const original = sandbox.ensureSession
    sandbox = { ...sandbox, ensureSession: () => Effect.fail(new BindingError({ cause: 'offline' })) }
    await expect(start()).rejects.toMatchObject({ _tag: 'BindingError' })
    expect(await current()).toMatchObject({ status: 'running', snapshot: { _tag: 'Starting' } })
    expect(submissions).toEqual([])
    sandbox = { ...sandbox, ensureSession: original }
    await resume()
    expect(submissions).toHaveLength(1)
    expect(
      Array.filter(
        await Effect.runPromise(store.getEvents(initialRun.runId)),
        (event) => event.type === 'node.started',
      ),
    ).toHaveLength(1)
  })
  it('fails closed when verification would use a replacement SDK session', async () => {
    await start()
    finishTurn('implement')
    session = { ...session, sessionId: 'replacement-session' }
    await resume()
    expect(await current()).toMatchObject({
      status: 'failed',
      snapshot: { nodeId: 'verify', message: expect.stringContaining('original active SDK session') },
    })
    expect(submissions).toHaveLength(1)
    expect(completeCalls).toEqual([])
  })
  it('recovers a completed SDK session when the final database checkpoint fails', async () => {
    await start()
    finishTurn('implement')
    await resume()
    finishTurn('verify')
    const failing: StoreService = {
      ...store,
      commit: (command) =>
        Schema.is(DevelopmentSnapshot)(command.snapshot) && command.snapshot._tag === 'Completed'
          ? Effect.fail(new StoreError({ operation: 'test final checkpoint failure', cause: 'unavailable' }))
          : store.commit(command),
    }
    await expect(execute(resumeDevelopmentRun(initialRun.runId), failing)).rejects.toMatchObject({ _tag: 'StoreError' })
    expect(await current()).toMatchObject({
      status: 'running',
      snapshot: { _tag: 'Completing', sessionId: 'sdk-session-1' },
    })
    expect(session.status).toBe('completed')
    await resume()
    expect(await current()).toMatchObject({ status: 'completed' })
    expect(submissions).toHaveLength(2)
    expect(
      Array.filter(
        await Effect.runPromise(store.getEvents(initialRun.runId)),
        (event) => event.type === 'run.completed',
      ),
    ).toHaveLength(1)
  })
  it('does not mark a replacement SDK session complete after verification', async () => {
    await start()
    finishTurn('implement')
    await resume()
    finishTurn('verify')
    session = { ...session, sessionId: 'replacement-session' }
    await resume()
    expect(await current()).toMatchObject({ status: 'failed', snapshot: { nodeId: 'verify' } })
    expect(completeCalls).toEqual([])
  })
  it('recovers a pending submission rejected before gateway acceptance using its original command ID', async () => {
    const original = sandbox.submitTurn
    sandbox = {
      ...sandbox,
      submitTurn: () => Effect.fail(new BindingError({ cause: 'unavailable before acceptance' })),
    }
    await expect(start()).rejects.toMatchObject({ _tag: 'BindingError' })
    expect(await current()).toMatchObject({ snapshot: { _tag: 'PendingTurn', commandId: 'development-1:implement:1' } })
    sandbox = { ...sandbox, submitTurn: original }
    await resume()
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.input.commandId).toBe('development-1:implement:1')
  })
  it('does not execute a turn before the node start checkpoint commits', async () => {
    const failing: StoreService = {
      ...store,
      commit: () => Effect.fail(new StoreError({ operation: 'test start failure', cause: 'unavailable' })),
    }
    await expect(execute(startDevelopmentRun(initialRun.runId), failing)).rejects.toMatchObject({ _tag: 'StoreError' })
    expect(submissions).toEqual([])
    expect(await current()).toEqual(initialRun)
  })
  it('rejects a restored run with a different pinned version', async () => {
    await expect(Effect.runPromise(restoreDevelopment({ ...initialRun, workflowVersion: 'v2' }))).rejects.toMatchObject(
      { _tag: 'InvalidSnapshot' },
    )
  })
})

describe('development CreateRun trust boundary', () => {
  it('accepts the new workflow without changing the demo v2 input', () => {
    expect(Schema.decodeUnknownSync(CreateRun)(input)).toEqual(input)
    expect(Schema.decodeUnknownSync(CreateRun)({ workflowId: 'demo', version: 'v2' })).toEqual({
      workflowId: 'demo',
      version: 'v2',
    })
  })
  it.each([
    'http://github.com/example/project',
    'https://gitlab.com/example/project',
    'https://github.com.evil.test/example/project',
    'https://user:secret@github.com/example/project',
    'https://github.com/example/project?token=secret',
    'https://github.com/example/project/tree/main',
  ])('rejects unsafe repository URL %s', (repository) => {
    expect(() => Schema.decodeUnknownSync(CreateRun)({ ...input, repository })).toThrow()
  })
  it.each(['', '   ', 'x'.repeat(16_001)])('rejects empty or oversized tasks', (task) => {
    expect(() => Schema.decodeUnknownSync(CreateRun)({ ...input, task })).toThrow()
  })
  it('rejects unsupported development version', () => {
    expect(() => Schema.decodeUnknownSync(CreateRun)({ ...input, version: 'v2' })).toThrow()
  })
})
