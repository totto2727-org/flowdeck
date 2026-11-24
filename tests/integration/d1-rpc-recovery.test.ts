import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { Array, Effect } from 'effect'
import { expect } from 'vite-plus/test'

import { createRun, resumeRun as resumeWorkflowRun } from '@/bridge/workflow/core/feature/workflow'
import { ExternalError, InvalidOperation } from '@/core/feature/workflow/domain/errors'
import { EventRange, Store } from '@/core/feature/workflow/services/store'
import type { StoreService } from '@/core/feature/workflow/services/store'
import { resumeRun, startRun } from '@/user-land/workflow/demo/feature/demo'

import { disconnectedRegistry, registryWithoutStoredWorkflow, withRegistry } from './d1-rpc-recovery.fixture.ts'
import { command, d1Fixture, newRun, primaryGraph, version1 } from './d1-workflows.fixture.ts'

const firstRun = command().runId

const unregisteredRun = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  const run = yield* newRun('run_00000000-0000-4000-8000-000000000004')
  const unsupported = { ...run, workflowId: 'unregistered-workflow' }
  yield* fixture.store.create(unsupported, primaryGraph, 'Unregistered workflow')
  return { fixture, unsupported }
})

live('rejects an unregistered persisted workflow before dispatch without changing its checkpoint', () =>
  Effect.gen(function* () {
    const { fixture, unsupported } = yield* unregisteredRun
    const { registry, resume } = yield* registryWithoutStoredWorkflow
    const operation = withRegistry(resumeWorkflowRun(unsupported.runId), fixture.store, registry)
    const failure = yield* Effect.flip(operation)
    expect(failure).toBeInstanceOf(InvalidOperation)
    expect(failure.message).toBe('The workflow is not registered')
    expect(resume).not.toHaveBeenCalled()
    expect(yield* fixture.store.getRun(unsupported.runId)).toStrictEqual(unsupported)
    expect(yield* fixture.store.getEvents(unsupported.runId, EventRange.All())).toStrictEqual([])
  }),
)

const failTerminalCommit = (persisted: StoreService): StoreService => ({
  ...persisted,
  commit: (input) =>
    input.status === 'completed'
      ? Effect.fail(
          new ExternalError({
            cause: 'test interruption',
            kind: 'storage',
            operation: 'injected checkpoint failure',
          }),
        )
      : persisted.commit(input),
})

const interruptedPublication = Effect.gen(function* () {
  const fixture = yield* d1Fixture
  yield* fixture.seedEffect()
  yield* fixture.provideTestServices(startRun(firstRun))
  const store = failTerminalCommit(fixture.store)
  const operation = resumeRun(firstRun).pipe(Effect.provideService(Store, store), Effect.provide(BrowserCrypto.layer))
  const error = yield* Effect.flip(operation)
  return { error, fixture }
})

live('retains the running publish checkpoint when its terminal commit fails', () =>
  Effect.gen(function* () {
    const { error, fixture } = yield* interruptedPublication
    expect(error).toBeInstanceOf(ExternalError)
    expect(error).toHaveProperty('kind', 'storage')
    expect(yield* fixture.store.getRun(firstRun)).toMatchObject({
      revision: 3,
      snapshot: { machine: { active: [{ path: '' }, { path: 'publish', value: { prepared: 'draft:v1' } }] } },
      status: 'running',
    })
  }),
)

live('restores a running publish checkpoint without replaying approval or node start', () =>
  Effect.gen(function* () {
    const { fixture } = yield* interruptedPublication
    fixture.store = yield* fixture.freshStore
    yield* fixture.provideTestServices(resumeRun(firstRun))
    const events = yield* fixture.store.getEvents(firstRun, EventRange.All())
    expect(Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'publish')).toHaveLength(1)
    const approvals = Array.filter(events, (event) => event.type === 'node.succeeded' && event.nodeId === 'approval')
    expect(approvals).toHaveLength(1)
    expect(yield* fixture.store.getRun(firstRun)).toMatchObject({ revision: 4, status: 'completed' })
    const start = fixture.provideTestServices(startRun(firstRun))
    expect(yield* Effect.flip(start)).toBeInstanceOf(InvalidOperation)
  }),
)

const createThroughDisconnectedWorker = Effect.fn('flowdeck.test.createThroughDisconnectedWorker')(function* (
  store: StoreService,
) {
  const registry = yield* disconnectedRegistry('start')
  const request = createRun({ version: version1, workflowId: 'demo' })
  return yield* withRegistry(request, store, registry)
})

live('leaves a recoverable pending run if its native static workflow RPC rejects', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    const error = yield* createThroughDisconnectedWorker(fixture.store).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExternalError)
    expect(error).toHaveProperty('kind', 'service')
    const runs = yield* fixture.store.listRuns
    expect(runs).toMatchObject([{ revision: 0, status: 'pending' }])
    const pending = Array.getUnsafe(runs, 0)
    yield* fixture.provideTestServices(resumeRun(pending.runId))
    expect(yield* fixture.store.getRun(pending.runId)).toMatchObject({ revision: 2, status: 'waiting' })
  }),
)

live('keeps the persisted checkpoint unchanged when an individual resume RPC rejects', () =>
  Effect.gen(function* () {
    const fixture = yield* d1Fixture
    yield* fixture.seedEffect(firstRun)
    yield* fixture.provideTestServices(startRun(firstRun))
    const readCheckpoint = Effect.all({
      events: fixture.store.getEvents(firstRun, EventRange.All()),
      run: fixture.store.getRun(firstRun),
    })
    const before = yield* readCheckpoint
    const registry = yield* disconnectedRegistry('resume')
    const error = yield* withRegistry(resumeWorkflowRun(firstRun), fixture.store, registry).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ExternalError)
    expect(error).toHaveProperty('kind', 'service')
    expect(yield* readCheckpoint).toStrictEqual(before)
  }),
)
