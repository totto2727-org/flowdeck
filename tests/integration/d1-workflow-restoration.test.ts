import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { makeRpcStub } from 'alchemy/Cloudflare/Workers'
import { Array, Data, Effect, Layer, Schema, SemVer } from 'effect'
import { TestCrypto } from 'effect/testing'
import { describe, expect, vi } from 'vite-plus/test'

import { createRun, resumeRun as resumeWorkflowRun } from '@/bridge/workflow/core/feature/workflow'
import { makeWorkflowRegistry } from '@/bridge/workflow/user-land/feature/registration'
import { WorkflowBinding } from '@/bridge/workflow/user-land/feature/workflow-binding'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { CommitId, EventId, ExecutionId } from '@/core/feature/workflow/domain/identity'
import type { Run } from '@/core/feature/workflow/domain/model'
import { LifecycleHook } from '@/core/feature/workflow/lifecycle'
import { EventRange, Store } from '@/core/feature/workflow/services/store'
import type { CommitCommand, StoreService } from '@/core/feature/workflow/services/store'
import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'
import { demoGraph, makeDemoExecutor, resumeRun, startRun } from '@/user-land/workflow/demo/feature/demo'

import {
  command,
  d1Fixture,
  newRun,
  unavailableDevelopmentBinding,
  version1,
  version2,
} from './d1-workflows.fixture.ts'

class DisconnectedWorkflow extends Data.TaggedError('DisconnectedWorkflow')<{ message: string }> {}
const disconnectedRegistry = Effect.fn(function* (method: 'start' | 'resume') {
  // The SDK converts the native promise rejection at the individual service-binding boundary.
  const binding = makeRpcStub<WorkflowBinding['Service']>({
    [method]: async () => {
      throw new DisconnectedWorkflow({ message: 'Individual worker disconnected' })
    },
  })
  return yield* makeWorkflowRegistry.pipe(
    Effect.provideService(WorkflowBinding, binding),
    Effect.provide(unavailableDevelopmentBinding),
  )
})

describe('demo cold restoration', () => {
  live('observes lifecycle hooks only after the matching snapshot and complete event batch are readable in D1', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const { runId } = command()
      yield* fixture.seedEffect(runId)
      let observations: Readonly<
        {
          revision: number
          persisted: Run
          eventIds: Readonly<string[]>
          storedEventIds: Readonly<string[]>
        }[]
      > = []
      const executor = yield* makeDemoExecutor.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Store, fixture.store),
            BrowserCrypto.layer,
            Layer.succeed(LifecycleHook, {
              afterCommit: (events, ack) =>
                Effect.gen(function* () {
                  const persisted = yield* fixture.store.getRun(ack.runId).pipe(Effect.orDie)
                  const committed = yield* fixture.store
                    .getEvents(ack.runId, EventRange.ThroughRevision({ revision: ack.revision }))
                    .pipe(Effect.orDie)
                  observations = Array.append(observations, {
                    revision: ack.revision,
                    persisted,
                    eventIds: Array.map(events, (event) => event.eventId),
                    storedEventIds: Array.map(
                      Array.filter(committed, (event) => event.sequence >= ack.firstSequence),
                      (event) => event.eventId,
                    ),
                  })
                }),
            }),
          ),
        ),
      )
      yield* executor.start(runId)
      yield* executor.resume(runId)
      expect(Array.map(observations, (observation) => observation.revision)).toStrictEqual(Array.range(1, 4))
      Array.forEach(observations, (observation) => {
        expect(observation.persisted.revision).toBe(observation.revision)
        expect(observation.storedEventIds).toStrictEqual(observation.eventIds)
      })
      expect(Array.last(observations)).toMatchObject({ value: { persisted: { status: 'completed' } } })
    }),
  )

  live('does not dispatch lifecycle hooks when D1 rejects the checkpoint revision', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const { runId } = command()
      yield* fixture.seedEffect(runId)
      const persisted = fixture.store
      const afterCommit = vi.fn(() => Effect.void)
      const executor = yield* makeDemoExecutor.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Store, {
              ...persisted,
              commit: (input) => persisted.commit({ ...input, expectedRevision: 999 }),
            }),
            Layer.succeed(LifecycleHook, { afterCommit }),
            BrowserCrypto.layer,
          ),
        ),
      )
      expect(yield* Effect.flip(executor.start(runId))).toBeDefined()
      expect(afterCommit).not.toHaveBeenCalled()
      expect(yield* persisted.getRun(runId)).toMatchObject({ revision: 0, status: 'pending' })
      expect(yield* persisted.getEvents(runId, EventRange.All())).toStrictEqual([])
    }),
  )

  live.each([version1, version2] as const)(
    'captures demo dependencies once and executes %s without a caller context',
    (version) =>
      Effect.gen(function* () {
        const fixture = yield* d1Fixture
        const { runId } = command()
        yield* fixture.seedEffect(runId, version)
        const executor = yield* makeDemoExecutor.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Store, fixture.store),
              TestCrypto.layer('captured-demo-executor').pipe(Layer.provide(BrowserCrypto.layer)),
            ),
          ),
        )
        yield* executor.start(runId)
        expect(yield* (yield* fixture.freshStore).getRun(runId)).toMatchObject({
          revision: 2,
          status: 'waiting',
        })
        yield* executor.resume(runId)
        expect(yield* (yield* fixture.freshStore).getRun(runId)).toMatchObject({
          revision: 4,
          status: 'completed',
        })
        expect(yield* fixture.store.getEvents(runId, EventRange.All())).toHaveLength(10)
      }),
  )

  live('generates prefixed UUIDv4 execution, event and commit identities and ACKs an exact duplicate commit', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const persisted = fixture.store
      let commits: Readonly<CommitCommand[]> = []
      fixture.store = {
        ...persisted,
        commit: (input) => {
          commits = Array.append(commits, input)
          return persisted.commit(input)
        },
      }
      yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
      yield* fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))
      expect(Array.every(commits, (input) => Schema.is(CommitId)(input.commitId))).toBe(true)
      const events = yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())
      expect(Array.every(events, (event) => Schema.is(EventId)(event.eventId))).toBe(true)
      expect(
        Array.every(events, (event) => !('executionId' in event) || Schema.is(ExecutionId)(event.executionId)),
      ).toBe(true)
      const first = Array.getUnsafe(commits, 0)
      const before = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
      expect(yield* fixture.store.commit(first)).toMatchObject({
        commitId: first.commitId,
        revision: 1,
      })
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(before)
      expect(
        yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All()),
      ).toStrictEqual(events)
    }),
  )

  live.each([version1, version2] as const)(
    'restores the waiting %s version in a new service and completes only after explicit resume',
    (version) =>
      Effect.gen(function* () {
        const fixture = yield* d1Fixture
        yield* fixture.seedEffect('run_00000000-0000-4000-8000-000000000001', version)
        yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
        const waiting = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
        expect(waiting).toMatchObject({
          status: 'waiting',
          revision: 2,
          workflowVersion: version,
          snapshot: { version: SemVer.format(version), machine: { active: [{ path: '' }, { path: 'approval' }] } },
        })
        fixture.store = yield* fixture.freshStore
        yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
        expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(waiting)
        yield* fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))
        const completed = yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')
        expect(completed).toMatchObject({
          status: 'completed',
          revision: 4,
          snapshot: {
            version: SemVer.format(version),
            machine: {
              active: [
                { path: '' },
                {
                  path: 'completed',
                  value: {
                    result: SemVer.equals(version, version1) ? 'published:draft:v1' : 'published:draft:v2:reviewed',
                  },
                },
              ],
            },
          },
        })
        const events = yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())
        expect(Array.map(events, (event) => event.sequence)).toStrictEqual(Array.range(1, 10))
        expect(
          Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'prepare'),
        ).toHaveLength(1)
        expect(
          yield* Effect.flip(fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))),
        ).toMatchObject({
          _tag: 'InvalidOperation',
        })
        expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toStrictEqual(completed)
      }),
  )

  live('recovers a committed running prepare checkpoint without duplicating its start event', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      const persisted = fixture.store
      fixture.store = {
        ...persisted,
        commit: (input) =>
          persisted.commit(input).pipe(
            Effect.andThen(
              Effect.fail(
                new ExternalError({
                  kind: 'storage',
                  operation: 'lost prepare checkpoint ACK',
                  cause: 'test transport loss',
                }),
              ),
            ),
          ),
      }
      expect(yield* Effect.flip(fixture.provideTestServices(startRun(command().runId)))).toMatchObject({
        _tag: 'ExternalError',
      })
      const checkpoint = yield* persisted.getRun(command().runId)
      expect(checkpoint).toMatchObject({ revision: 1, status: 'running' })
      expect(yield* persisted.getEvents(command().runId, EventRange.All())).toHaveLength(2)
      fixture.store = yield* fixture.freshStore
      yield* fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 2,
        status: 'waiting',
      })
      expect(
        Array.filter(
          yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All()),
          (event) => event.type === 'node.started' && event.nodeId === 'prepare',
        ),
      ).toHaveLength(1)
    }),
  )

  live('rejects malformed or version-mismatched restored state before executing a node', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.store.commit(command({ snapshot: { _tag: 'Preparing', version: 'v9' } }))
      expect(
        yield* Effect.flip(fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))),
      ).toMatchObject({
        _tag: 'InvalidSnapshot',
      })
      expect(yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())).toHaveLength(
        1,
      )
    }),
  )
})

describe('interrupted workflow recovery', () => {
  live('rejects an unregistered persisted workflow before dispatch without changing its checkpoint', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const unsupported = {
        ...(yield* newRun('run_00000000-0000-4000-8000-000000000004')),
        workflowId: 'unregistered-workflow',
      }
      yield* fixture.store.create(unsupported, demoGraph(version1), 'Unregistered workflow')
      const resume = vi.fn(() => Effect.die('Unregistered workflows must not dispatch'))
      const binding = { start: resume, resume }
      const registry = [{ ...demoDefinition, binding }]
      expect(
        yield* Effect.flip(
          resumeWorkflowRun(unsupported.runId).pipe(
            Effect.provideService(Store, fixture.store),
            Effect.provideService(WorkflowRegistry, registry),
          ),
        ),
      ).toMatchObject({ _tag: 'InvalidOperation', message: 'The workflow is not registered' })
      expect(resume).not.toHaveBeenCalled()
      expect(yield* fixture.store.getRun(unsupported.runId)).toStrictEqual(unsupported)
      expect(yield* fixture.store.getEvents(unsupported.runId, EventRange.All())).toStrictEqual([])
    }),
  )

  live('restores a running publish checkpoint without replaying manual approval or node start', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      yield* fixture.seedEffect()
      yield* fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))
      const persisted = fixture.store
      const interrupted: StoreService = {
        ...persisted,
        commit: (input) =>
          input.status === 'completed'
            ? Effect.fail(
                new ExternalError({
                  kind: 'storage',
                  operation: 'injected checkpoint failure',
                  cause: 'test interruption',
                }),
              )
            : persisted.commit(input),
      }
      expect(
        yield* Effect.flip(
          resumeRun('run_00000000-0000-4000-8000-000000000001').pipe(
            Effect.provideService(Store, interrupted),
            Effect.provide(BrowserCrypto.layer),
          ),
        ),
      ).toMatchObject({ _tag: 'ExternalError', kind: 'storage' })
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 3,
        snapshot: { machine: { active: [{ path: '' }, { path: 'publish', value: { prepared: 'draft:v1' } }] } },
        status: 'running',
      })
      fixture.store = yield* fixture.freshStore
      yield* fixture.provideTestServices(resumeRun('run_00000000-0000-4000-8000-000000000001'))
      const events = yield* fixture.store.getEvents('run_00000000-0000-4000-8000-000000000001', EventRange.All())
      expect(Array.filter(events, (event) => event.type === 'node.started' && event.nodeId === 'publish')).toHaveLength(
        1,
      )
      expect(
        Array.filter(events, (event) => event.type === 'node.succeeded' && event.nodeId === 'approval'),
      ).toHaveLength(1)
      expect(yield* fixture.store.getRun('run_00000000-0000-4000-8000-000000000001')).toMatchObject({
        revision: 4,
        status: 'completed',
      })
      expect(
        yield* Effect.flip(fixture.provideTestServices(startRun('run_00000000-0000-4000-8000-000000000001'))),
      ).toMatchObject({
        _tag: 'InvalidOperation',
      })
    }),
  )

  live('leaves a recoverable pending run if its native static workflow RPC rejects', () =>
    Effect.gen(function* () {
      const fixture = yield* d1Fixture
      const registry = yield* disconnectedRegistry('start')
      const create = createRun({ version: version1, workflowId: 'demo' }).pipe(
        Effect.provideService(Store, fixture.store),
        Effect.provideService(WorkflowRegistry, registry),
        Effect.provide(BrowserCrypto.layer),
      )
      const error = yield* Effect.flip(create)
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
      const { runId } = command()
      yield* fixture.seedEffect(runId)
      yield* fixture.provideTestServices(startRun(runId))
      const waiting = yield* fixture.store.getRun(runId)
      const events = yield* fixture.store.getEvents(runId, EventRange.All())
      const registry = yield* disconnectedRegistry('resume')
      const resume = resumeWorkflowRun(runId).pipe(
        Effect.provideService(Store, fixture.store),
        Effect.provideService(WorkflowRegistry, registry),
      )
      const error = yield* Effect.flip(resume)
      expect(error).toBeInstanceOf(ExternalError)
      expect(error).toHaveProperty('kind', 'service')
      expect(yield* fixture.store.getRun(runId)).toStrictEqual(waiting)
      expect(yield* fixture.store.getEvents(runId, EventRange.All())).toStrictEqual(events)
    }),
  )
})
