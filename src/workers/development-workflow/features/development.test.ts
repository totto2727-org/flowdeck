import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { BrowserCrypto } from '@effect/platform-browser'
import { Machine } from '@typeonce/effect-machine'
import { Array, Crypto, DateTime, Effect, Layer, Option, Schema, SemVer } from 'effect'
import { HttpRouter } from 'effect/http'
import { TestCrypto } from 'effect/testing'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { D1Binding, NativeD1Client } from '@/features/d1/native'
import { AlchemyQueryExecutorLive } from '@/features/d1/reylo'
import { ExternalError } from '@/features/workflow/domain/errors'
import { CommitId, EventId, ExecutionId } from '@/features/workflow/domain/identity'
import { JsonObject, RunDetail, type Run } from '@/features/workflow/domain/model'
import { D1StoreLive } from '@/features/workflow/services/d1-store'
import { DatabaseQueriesLive } from '@/features/workflow/services/database-queries'
import { Store, type StoreService } from '@/features/workflow/services/store'
import { WorkflowRegistry } from '@/features/workflow/services/workflow-definition'
import { Workflows } from '@/features/workflow/services/workflows'
import { ApiRoutes } from '@/workers/control/features/router'
import { makeWorkflowRegistry } from '@/workers/workflow/features/registration'
import { makeWorkflows } from '@/workers/workflow/features/workflow'
import { DevelopmentWorkflowBinding, WorkflowBinding } from '@/workers/workflow/features/workflow-binding'

import {
  DevelopmentSnapshotJson,
  developmentGraph,
  initialDevelopmentSnapshot,
  makeDevelopmentExecutor,
  restoreDevelopment,
  resumeDevelopmentRun,
  startDevelopmentRun,
} from './development'
import { DevelopmentMachine, DevelopmentStates } from './development-machine'
import { DevelopmentCreateRun, developmentVersion } from './input'
import { CommandId } from './model'
import type { Session, TurnReceipt, TurnRequest } from './model'
import { DevelopmentSandbox } from './sandbox'

const input = {
  workflowId: 'jcode-development',
  version: developmentVersion,
  repository: new URL('https://github.com/example/project'),
  task: 'Add a greeting and test it.',
} as const
const timestamp = DateTime.makeUnsafe('2026-10-17T12:00:00.000Z')
const initialRun: Run = {
  runId: 'run_00000000-0000-4000-8000-000000000002',
  workflowId: input.workflowId,
  workflowVersion: developmentVersion,
  graphId: developmentGraph.graphId,
  status: 'pending',
  revision: 0,
  snapshot: Schema.decodeUnknownSync(JsonObject)(
    Schema.encodeSync(DevelopmentSnapshotJson)(initialDevelopmentSnapshot(input)),
  ),
  createdAt: timestamp,
  updatedAt: timestamp,
}
const decodeSnapshot = Schema.decodeUnknownSync(DevelopmentSnapshotJson)
const nativeOf = (snapshot: unknown) =>
  Effect.runSync(Machine.decodeSnapshot(DevelopmentMachine, decodeSnapshot(snapshot).machine))
const activeOf = (snapshot: unknown) => {
  const native = nativeOf(snapshot)
  return Option.getOrThrow(
    Option.orElse(DevelopmentStates.get(native, 'implement.intent'), () =>
      Option.orElse(DevelopmentStates.get(native, 'implement.awaiting'), () =>
        Option.orElse(DevelopmentStates.get(native, 'verify.intent'), () =>
          DevelopmentStates.get(native, 'verify.awaiting'),
        ),
      ),
    ),
  )
}
const rootOf = (snapshot: unknown) => Option.getOrThrow(DevelopmentStates.get(nativeOf(snapshot), ''))
const matches = (snapshot: unknown, path: Parameters<typeof DevelopmentStates.matches>[1]) =>
  DevelopmentStates.matches(nativeOf(snapshot), path)
const failedOf = (snapshot: unknown) => Option.getOrThrow(DevelopmentStates.get(nativeOf(snapshot), 'failed'))
let miniflare: Miniflare
let store: StoreService
let storeLayer: Layer.Layer<Store>
const freshStore = () => Effect.runSync(Store.pipe(Effect.provide(storeLayer)))
let receipts: Record<string, TurnReceipt>
let submissions: ReadonlyArray<{ readonly runId: string; readonly input: TurnRequest }>
let session: Session
let ensureCalls: number
let completeCalls: ReadonlyArray<string>
let sandbox: DevelopmentSandbox['Service']
beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default {}',
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'development-test' },
  })
  const database: D1Database = await miniflare.getD1Database('DB')
  const migrations = await readD1Migrations('migrations')
  await database.batch(
    Array.map(
      Array.flatMap(migrations, (migration) => migration.queries),
      (query) => database.prepare(query),
    ),
  )
  storeLayer = D1StoreLive.pipe(
    Layer.provide(DatabaseQueriesLive),
    Layer.provide(AlchemyQueryExecutorLive),
    Layer.provide(NativeD1Client),
    Layer.provide(Layer.succeed(D1Binding, database)),
  )
  store = freshStore()
  await Effect.runPromise(store.create(initialRun, developmentGraph, 'Pi development'))
  receipts = {}
  submissions = []
  completeCalls = []
  ensureCalls = 0
  session = { sessionId: '1', model: 'test-model', status: 'active' }
  sandbox = {
    ensureSession: () =>
      Effect.sync(() => {
        ensureCalls += 1
        return session
      }),
    getTurn: (_runId, commandId) => Effect.sync(() => receipts[commandId] ?? null),
    submitTurn: (runId, request) =>
      Effect.gen(function* () {
        const current = yield* store.getRun(runId)
        expect(current.status).toBe('running')
        const intent = activeOf(current.snapshot)
        expect(intent.commandId).toBe(request.commandId)
        expect(Schema.is(ExecutionId)(intent.executionId)).toBe(true)
        expect(matches(current.snapshot, 'implement.intent') || matches(current.snapshot, 'verify.intent')).toBe(true)
        submissions = Array.append(submissions, { runId, input: request })
        const receipt = { commandId: request.commandId, status: 'running' } as const
        receipts = { ...receipts, [request.commandId]: receipt }
        return receipt
      }).pipe(Effect.mapError((cause) => new ExternalError({ kind: 'service', operation: 'test binding', cause }))),
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
const execute = <A, E>(
  effect: Effect.Effect<A, E, Store | DevelopmentSandbox | Crypto.Crypto>,
  suppliedStore = freshStore(),
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Store, suppliedStore),
      Effect.provideService(DevelopmentSandbox, sandbox),
      Effect.provide(BrowserCrypto.layer),
    ),
  )
const current = () => Effect.runPromise(freshStore().getRun(initialRun.runId))
const events = () => Effect.runPromise(store.getEvents(initialRun.runId, { _tag: 'All' }))
const start = () => execute(startDevelopmentRun(initialRun.runId))
const resume = () => execute(resumeDevelopmentRun(initialRun.runId))
const finishTurn = (node: 'implement' | 'verify') => {
  const commandId = submissions[node === 'implement' ? 0 : 1]!.input.commandId
  receipts = { ...receipts, [commandId]: { commandId, status: 'completed', text: `${node} result` } }
}
const offline = () => Effect.fail(new ExternalError({ kind: 'service', operation: 'test binding', cause: 'offline' }))
const rejectCommit = () =>
  Effect.fail(new ExternalError({ kind: 'storage', operation: 'test checkpoint failure', cause: 'unavailable' }))

// The maintained integration tests execute the public workflow entry against
// real D1. Only the remote PiHarness/Container boundary is substituted.
describe('development workflow with canonical D1 checkpoints', () => {
  it('captures stable provider dependencies once and completes without caller context', async () => {
    const executor = await execute(makeDevelopmentExecutor)
    sandbox = { ensureSession: offline, submitTurn: offline, getTurn: offline, complete: offline }
    await Effect.runPromise(executor.start(initialRun.runId))
    expect(matches((await current()).snapshot, 'implement.awaiting')).toBe(true)
    finishTurn('implement')
    await Effect.runPromise(executor.resume(initialRun.runId))
    expect(matches((await current()).snapshot, 'verify.awaiting')).toBe(true)
    finishTurn('verify')
    await Effect.runPromise(executor.resume(initialRun.runId))
    expect((await current()).status).toBe('completed')
    expect(submissions).toHaveLength(2)
    expect(completeCalls).toEqual([initialRun.runId])
  })

  it.each([
    'run_00000000-0000-4000-8000-000000000002:implement:1',
    '3d360c7a-4b1a-4df3-9633-861a220bf5b7',
    '01890f2e-7b55-7cc1-8c5a-000000000001',
    'not-a-uuid',
  ])('rejects invalid persisted command identity %s before Pi access', async (commandId) => {
    await start()
    const before = await current()
    const encoded = Schema.encodeSync(Schema.toCodecJson(JsonObject))(decodeSnapshot(before.snapshot).machine)
    // The native wire is rewritten only at the trust boundary to simulate corrupt storage.
    const corrupted = Schema.decodeUnknownSync(JsonObject)(
      JSON.parse(JSON.stringify(encoded).replaceAll(submissions[0]!.input.commandId, commandId)),
    )
    await expect(
      Effect.runPromise(restoreDevelopment({ ...before, snapshot: { ...before.snapshot, machine: corrupted } })),
    ).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
    expect(submissions).toHaveLength(1)
  })

  it('routes create and read-only Resume through the static development binding', async () => {
    const provide = <A, E>(effect: Effect.Effect<A, E, Store | DevelopmentSandbox | Crypto.Crypto>) =>
      effect.pipe(
        Effect.provideService(Store, freshStore()),
        Effect.provideService(DevelopmentSandbox, sandbox),
        Effect.provide(BrowserCrypto.layer),
      )
    const handler = HttpRouter.toWebHandler(
      ApiRoutes.pipe(
        HttpRouter.provideRequest(
          Layer.effect(Workflows, makeWorkflows).pipe(
            Layer.provide(Layer.effect(WorkflowRegistry, makeWorkflowRegistry)),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Store, store),
                Layer.succeed(DevelopmentWorkflowBinding, {
                  start: (runId) => provide(startDevelopmentRun(runId)),
                  resume: (runId) => provide(resumeDevelopmentRun(runId)),
                }),
                Layer.succeed(WorkflowBinding, { start: offline, resume: offline }),
                TestCrypto.layer('development-api').pipe(Layer.provide(BrowserCrypto.layer)),
              ),
            ),
          ),
        ),
      ),
    )
    try {
      const response = await handler.handler(
        new Request('http://localhost/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, repository: input.repository.href, version: '1.0.0' }),
        }),
      )
      expect(response.status).toBe(201)
      const detail = Schema.decodeUnknownSync(Schema.toCodecJson(RunDetail))(await response.json())
      expect(detail.run).toMatchObject({
        workflowId: 'jcode-development',
        workflowVersion: developmentVersion,
        status: 'waiting',
      })
      expect(rootOf(detail.run.snapshot)).toMatchObject({
        runtime: 'pi-harness',
        repository: input.repository,
        task: input.task,
      })
      const resumed = await handler.handler(
        new Request(`http://localhost/api/runs/${detail.run.runId}/resume`, { method: 'POST' }),
      )
      expect(resumed.status).toBe(200)
      expect(Schema.decodeUnknownSync(Schema.toCodecJson(RunDetail))(await resumed.json()).run).toEqual(detail.run)
      expect(submissions).toHaveLength(1)
    } finally {
      await handler.dispose()
    }
  })

  it('persists native inputs, pinned version and immutable graph before starting', async () => {
    expect(await current()).toEqual(initialRun)
    expect(rootOf(initialRun.snapshot)).toMatchObject({
      runtime: 'pi-harness',
      repository: input.repository,
      task: input.task,
    })
    expect(await Effect.runPromise(store.getGraph(initialRun.graphId))).toEqual(developmentGraph)
    expect(matches(initialRun.snapshot, 'implement.allocate')).toBe(true)
    expect(initialRun.snapshot).not.toHaveProperty('context')
  })

  describe.each([undefined, 'pi'] as const)('legacy runtime %s', (runtime) => {
    it.each([
      ['Ready', 'pending'],
      ['Starting', 'running'],
      ['PendingTurn', 'running'],
      ['AwaitingTurn', 'waiting'],
      ['Completing', 'running'],
      ['Completed', 'completed'],
      ['Failed', 'failed'],
    ] as const)('rejects legacy %s without accessing Pi', async (_tag, status) => {
      await Effect.runPromise(
        store.commit({
          commitId: 'commit_00000000-0000-4000-8000-000000000011',
          runId: initialRun.runId,
          expectedRevision: 0,
          status,
          snapshot: {
            _tag,
            ...(runtime === undefined ? {} : { runtime }),
            schemaVersion: 1,
            version: '1.0.0',
            repository: input.repository.href,
            task: input.task,
            commandId: 'run_00000000-0000-4000-8000-000000000002:implement:1',
            sessionId: 'legacy-session',
            nodeId: 'implement',
            result: 'old',
            message: 'old',
          },
          updatedAt: timestamp,
          events: [],
        }),
      )
      const before = await current()
      sandbox = {
        ensureSession: () => Effect.die('must not access Pi'),
        submitTurn: () => Effect.die('must not submit'),
        getTurn: () => Effect.die('must not poll'),
        complete: () => Effect.die('must not complete'),
      }
      await expect(Effect.runPromise(restoreDevelopment(before))).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
      await expect(start()).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
      await expect(resume()).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
      expect(await current()).toEqual(before)
      expect(await events()).toEqual([])
    })
  })

  it('commits stable command and execution identity before external initialization and submission', async () => {
    let commitIds: ReadonlyArray<string> = []
    const ensure = sandbox.ensureSession
    sandbox = {
      ...sandbox,
      ensureSession: (runId) =>
        Effect.gen(function* () {
          const persisted = yield* store.getRun(runId)
          expect(matches(persisted.snapshot, 'implement.intent')).toBe(true)
          expect(Schema.is(CommandId)(activeOf(persisted.snapshot).commandId)).toBe(true)
          return yield* ensure(runId)
        }).pipe(Effect.mapError((cause) => new ExternalError({ kind: 'service', operation: 'test ensure', cause }))),
    }
    await execute(startDevelopmentRun(initialRun.runId), {
      ...store,
      commit: (command) => {
        commitIds = Array.append(commitIds, command.commitId)
        return store.commit(command)
      },
    })
    expect(commitIds).toHaveLength(2)
    expect(Array.every(commitIds, Schema.is(CommitId))).toBe(true)
    const persisted = await current()
    const execution = activeOf(persisted.snapshot)
    expect(execution.commandId).toBe(submissions[0]?.input.commandId)
    expect(execution.executionId).not.toBe(execution.commandId)
    expect(matches(persisted.snapshot, 'implement.awaiting')).toBe(true)
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.input.prompt).toContain('/workspace/project')
    expect(submissions[0]?.input.prompt).toContain('Use the official Vite+ CLI')
    expect(submissions[0]?.input.prompt).toContain('Let vp env resolve the target project versions')
    expect(submissions[0]?.input.prompt).toContain(
      'Use nix develop or a minimal temporary nix shell only for non-JavaScript tools',
    )
    expect(submissions[0]?.input.prompt).toContain(input.repository.href)
    expect(submissions[0]?.input.prompt).toContain(input.task)
    expect(submissions[0]?.input.prompt).not.toContain('/sandbox/')
    expect(submissions[0]?.input.prompt).not.toContain('/home/sandbox/')
    const recorded = await events()
    expect(Array.map(recorded, (event) => event.type)).toEqual(['run.started', 'node.started', 'run.waiting'])
    expect(recorded[0]).not.toHaveProperty('nodeId')
    expect(recorded[0]).not.toHaveProperty('executionId')
    expect(recorded[0]).not.toHaveProperty('attempt')
    expect(recorded[2]).toMatchObject({
      type: 'run.waiting',
      nodeId: 'implement',
      executionId: execution.executionId,
      attempt: 1,
    })
    expect(Array.every(recorded, (event) => DateTime.isUtc(event.createdAt))).toBe(true)
    expect(DateTime.isUtc(persisted.createdAt)).toBe(true)
    expect(DateTime.isUtc(persisted.updatedAt)).toBe(true)
  })

  it('polls a running operation read-only without changing checkpoints, events, initialization or submission', async () => {
    await start()
    const before = await current()
    const recorded = await events()
    const initialized = ensureCalls
    await resume()
    expect(await current()).toEqual(before)
    expect(await events()).toEqual(recorded)
    expect(ensureCalls).toBe(initialized)
    expect(submissions).toHaveLength(1)
  })

  it('ignores repeated Start while waiting for explicit Resume', async () => {
    await start()
    finishTurn('implement')
    const before = await current()
    await start()
    expect(await current()).toEqual(before)
    expect(submissions).toHaveLength(1)
  })

  it('reconstructs native runtime and submits verification in the same run and root session', async () => {
    await start()
    finishTurn('implement')
    await resume()
    expect(matches((await current()).snapshot, 'verify.awaiting')).toBe(true)
    expect(submissions).toHaveLength(2)
    expect(submissions[1]?.input.commandId).not.toBe(submissions[0]?.input.commandId)
    expect(Schema.is(CommandId)(submissions[1]?.input.commandId)).toBe(true)
    expect(submissions[1]?.runId).toBe(initialRun.runId)
    expect(submissions[1]?.input.prompt).toContain('same /workspace/project')
    expect(submissions[1]?.input.prompt).toContain('official Vite+ CLI')
    expect(submissions[1]?.input.prompt).not.toContain('/sandbox/')
    expect(submissions[1]?.input.prompt).not.toContain('/home/sandbox/')
    expect(completeCalls).toEqual([])
    expect(session.sessionId).toBe('1')
  })

  it('completes only after verification and retains container with canonical event identities', async () => {
    await start()
    finishTurn('implement')
    await resume()
    finishTurn('verify')
    await resume()
    const persisted = await current()
    expect(persisted.status).toBe('completed')
    expect(Option.getOrThrow(DevelopmentStates.get(nativeOf(persisted.snapshot), 'completed')).result).toBe(
      'verify result',
    )
    expect(completeCalls).toEqual([initialRun.runId])
    const recorded = await events()
    expect(Array.every(recorded, (event) => Schema.is(EventId)(event.eventId))).toBe(true)
    const verification = Array.filter(recorded, (event) => 'nodeId' in event && event.nodeId === 'verify')
    expect(verification).toHaveLength(3)
    expect(
      Array.every(verification, (event) => 'executionId' in event && Schema.is(ExecutionId)(event.executionId)),
    ).toBe(true)
    expect(verification[0]).toHaveProperty(
      'executionId',
      'executionId' in verification[1]! ? verification[1].executionId : '',
    )
    expect(Array.map(recorded, (event) => event.type)).toEqual([
      'run.started',
      'node.started',
      'run.waiting',
      'run.resumed',
      'node.succeeded',
      'node.started',
      'run.waiting',
      'run.resumed',
      'node.succeeded',
      'run.completed',
    ])
    await expect(resume()).rejects.toMatchObject({ _tag: 'InvalidOperation' })
  })

  it.each(['failed', 'interrupted'] as const)(
    'commits a %s receipt as a business failure and retains the container',
    async (status) => {
      await start()
      const commandId = submissions[0]!.input.commandId
      receipts = {
        [commandId]: { commandId, status, error: status === 'failed' ? 'sdk_failure' : 'runtime_interrupted' },
      }
      await resume()
      expect((await current()).status).toBe('failed')
      expect(failedOf((await current()).snapshot).nodeId).toBe('implement')
      expect(Array.map(Array.takeRight(await events(), 2), (event) => event.type)).toEqual([
        'node.failed',
        'run.failed',
      ])
      expect(submissions).toHaveLength(1)
      expect(completeCalls).toEqual([])
    },
  )

  it('never resubmits an acknowledged operation whose receipt disappears', async () => {
    await start()
    receipts = {}
    await resume()
    expect((await current()).status).toBe('failed')
    expect(failedOf((await current()).snapshot).message).toContain('will not be resubmitted')
    expect(submissions).toHaveLength(1)
  })

  it('recovers accepted submit after the Waiting checkpoint fails without another submission', async () => {
    await expect(
      execute(startDevelopmentRun(initialRun.runId), {
        ...store,
        commit: (command) => (command.status === 'waiting' ? rejectCommit() : store.commit(command)),
      }),
    ).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'storage' })
    expect(matches((await current()).snapshot, 'implement.intent')).toBe(true)
    await resume()
    expect(matches((await current()).snapshot, 'implement.awaiting')).toBe(true)
    expect(submissions).toHaveLength(1)
    expect(Array.filter(await events(), (event) => event.type === 'node.started')).toHaveLength(1)
  })

  it('recovers session initialization failure with one stable command and execution identity', async () => {
    const original = sandbox.ensureSession
    sandbox = { ...sandbox, ensureSession: offline }
    await expect(start()).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'service' })
    const before = activeOf((await current()).snapshot)
    expect(matches((await current()).snapshot, 'implement.intent')).toBe(true)
    expect(submissions).toEqual([])
    sandbox = { ...sandbox, ensureSession: original }
    await resume()
    expect(submissions).toHaveLength(1)
    expect(activeOf((await current()).snapshot)).toMatchObject({
      commandId: before.commandId,
      executionId: before.executionId,
    })
    expect(Array.filter(await events(), (event) => event.type === 'node.started')).toHaveLength(1)
  })

  it('fails closed when verification finds an already completed session', async () => {
    await start()
    finishTurn('implement')
    session = { ...session, status: 'completed' }
    await resume()
    expect(failedOf((await current()).snapshot)).toMatchObject({
      nodeId: 'verify',
      message: expect.stringContaining('original active Pi session'),
    })
    expect(submissions).toHaveLength(1)
    expect(completeCalls).toEqual([])
  })

  it('recovers acknowledged completion after terminal checkpoint failure without another turn', async () => {
    await start()
    finishTurn('implement')
    await resume()
    finishTurn('verify')
    await expect(
      execute(resumeDevelopmentRun(initialRun.runId), {
        ...store,
        commit: (command) => (command.status === 'completed' ? rejectCommit() : store.commit(command)),
      }),
    ).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'storage' })
    expect(matches((await current()).snapshot, 'verify.completing')).toBe(true)
    expect(session.status).toBe('completed')
    await resume()
    expect((await current()).status).toBe('completed')
    expect(submissions).toHaveLength(2)
    expect(Array.filter(await events(), (event) => event.type === 'run.completed')).toHaveLength(1)
  })

  it('recovers completion transport failure from durable result without polling or resubmitting', async () => {
    await start()
    finishTurn('implement')
    await resume()
    finishTurn('verify')
    const complete = sandbox.complete
    sandbox = { ...sandbox, complete: offline }
    await expect(resume()).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'service' })
    const persisted = await current()
    expect(matches(persisted.snapshot, 'verify.completing')).toBe(true)
    expect(Option.getOrThrow(DevelopmentStates.get(nativeOf(persisted.snapshot), 'verify.completing')).result).toBe(
      'verify result',
    )
    sandbox = {
      ...sandbox,
      complete,
      getTurn: () => Effect.die('Completion recovery must not poll a finished operation'),
    }
    await resume()
    expect((await current()).status).toBe('completed')
    expect(submissions).toHaveLength(2)
    expect(completeCalls).toEqual([initialRun.runId])
  })

  it('rejects a receipt with a different command identity without submitting again', async () => {
    await start()
    const commandId = submissions[0]!.input.commandId
    receipts = {
      [commandId]: {
        commandId: 'command_00000000-0000-4000-8000-000000000099',
        status: 'completed',
        text: 'wrong operation',
      },
    }
    await resume()
    expect((await current()).status).toBe('failed')
    expect(failedOf((await current()).snapshot).message).toContain('different command identity')
    expect(submissions).toHaveLength(1)
  })

  it('rejects historical completing checkpoints with missing command and execution identities', async () => {
    const snapshot = {
      _tag: 'Completing',
      runtime: 'pi-harness',
      schemaVersion: 1,
      version: '1.0.0',
      repository: input.repository.href,
      task: input.task,
      sessionId: '1',
      result: 'historical result',
    }
    await Effect.runPromise(
      store.commit({
        commitId: 'commit_00000000-0000-4000-8000-000000000012',
        runId: initialRun.runId,
        expectedRevision: 0,
        status: 'running',
        snapshot,
        updatedAt: timestamp,
        events: [],
      }),
    )
    const before = await current()
    await expect(Effect.runPromise(restoreDevelopment(before))).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
    await expect(resume()).rejects.toMatchObject({ _tag: 'InvalidSnapshot' })
    expect(await current()).toEqual(before)
    expect(submissions).toEqual([])
    expect(completeCalls).toEqual([])
  })

  it('fails when Pi completion is not acknowledged after verification', async () => {
    await start()
    finishTurn('implement')
    await resume()
    finishTurn('verify')
    sandbox = { ...sandbox, complete: () => Effect.succeed(session) }
    await resume()
    expect(failedOf((await current()).snapshot).nodeId).toBe('verify')
    expect(completeCalls).toEqual([])
  })

  it('recovers submit rejected before acceptance using the original command ID', async () => {
    const original = sandbox.submitTurn
    sandbox = { ...sandbox, submitTurn: offline }
    await expect(start()).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'service' })
    const pending = activeOf((await current()).snapshot)
    sandbox = { ...sandbox, submitTurn: original }
    await resume()
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.input.commandId).toBe(pending.commandId)
  })

  it('prevents initialization and submission when the intent checkpoint rejects', async () => {
    await expect(
      execute(startDevelopmentRun(initialRun.runId), { ...store, commit: rejectCommit }),
    ).rejects.toMatchObject({ _tag: 'ExternalError', kind: 'storage' })
    expect(ensureCalls).toBe(0)
    expect(submissions).toEqual([])
    expect(await current()).toEqual(initialRun)
  })

  it.each([
    { workflowVersion: SemVer.make({ major: 2, minor: 0, patch: 0 }) },
    { graphId: 'different-graph' },
    { workflowId: 'demo' },
    { status: 'running' as const },
  ])('rejects mismatched persisted identity or status before execution', async (changed) => {
    await expect(Effect.runPromise(restoreDevelopment({ ...initialRun, ...changed }))).rejects.toMatchObject({
      _tag: 'InvalidSnapshot',
    })
    expect(submissions).toEqual([])
  })
})

describe('development CreateRun trust boundary', () => {
  it('decodes wire SemVer and URL into ideal domain input', () => {
    expect(
      Schema.decodeUnknownSync(Schema.toCodecJson(DevelopmentCreateRun))({
        ...input,
        repository: input.repository.href,
        version: '1.0.0',
      }),
    ).toEqual(input)
  })
  it.each([
    'http://github.com/example/project',
    'https://gitlab.com/example/project',
    'https://github.com.evil.test/example/project',
    'https://user:secret@github.com/example/project',
    'https://github.com/example/project?token=secret',
    'https://github.com/example/project/tree/main',
  ])('rejects unsafe repository URL %s', (repository) => {
    expect(() =>
      Schema.decodeUnknownSync(Schema.toCodecJson(DevelopmentCreateRun))({ ...input, version: '1.0.0', repository }),
    ).toThrow()
  })
  it.each(['', '   ', 'x'.repeat(16_001)])('rejects empty or oversized task', (task) => {
    expect(() =>
      Schema.decodeUnknownSync(Schema.toCodecJson(DevelopmentCreateRun))({
        ...input,
        repository: input.repository.href,
        version: '1.0.0',
        task,
      }),
    ).toThrow()
  })
  it.each(['v1', 'v2', '1.0.1', '2.0.0'])('rejects unsupported version %s', (version) => {
    expect(() =>
      Schema.decodeUnknownSync(Schema.toCodecJson(DevelopmentCreateRun))({
        ...input,
        repository: input.repository.href,
        version,
      }),
    ).toThrow()
  })
})
