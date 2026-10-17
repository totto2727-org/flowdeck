import type { ContainerClient } from 'alchemy/Cloudflare/Containers'
import type { DurableObjectStorage } from 'alchemy/Cloudflare/Workers'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Array, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vite-plus/test'

import { BindingError, StoreError } from '../../../features/workflow/domain/errors'
import type { Run, RunStatus } from '../../../features/workflow/domain/model'
import type { StoreService } from '../../../features/workflow/services/store'
import { renewDevelopmentLease } from './lease'

const runtime = RuntimeContext.of({
  Type: 'test',
  id: 'lease-test',
  env: {},
  get: () => Effect.succeed(undefined),
  set: (id) => Effect.succeed(id),
})
const fixture = (status: RunStatus = 'waiting', running = true) => {
  let timeout: number | bigint | null = null
  let alarms: ReadonlyArray<number> = []
  let cleared = 0
  const run: Run = {
    runId: 'lease-run',
    workflowId: 'jcode-development',
    workflowVersion: 'v1',
    graphId: 'jcode-development:v1:graph:1',
    status,
    revision: 1,
    snapshot: {},
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  }
  const store: Pick<StoreService, 'getRun'> = { getRun: () => Effect.succeed(run) }
  const container: Pick<ContainerClient, 'running' | 'setInactivityTimeout'> = {
    running: Effect.succeed(running),
    setInactivityTimeout: (duration) =>
      Effect.sync(() => {
        timeout = duration
      }),
  }
  const storage: Pick<DurableObjectStorage, 'setAlarm' | 'deleteAlarm'> = {
    setAlarm: (time) =>
      Effect.sync(() => {
        alarms = Array.append(alarms, typeof time === 'number' ? time : time.getTime())
      }),
    deleteAlarm: () =>
      Effect.sync(() => {
        cleared += 1
      }),
  }
  return {
    store,
    container,
    storage,
    observed: () => ({ timeout, alarms, cleared }),
    renew: (runId: string | undefined = run.runId) => renewDevelopmentLease(runId, store, container, storage),
  }
}
const execute = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(RuntimeContext, runtime), Effect.provide(TestClock.layer())))

describe('development workspace lease', () => {
  it.each(['pending', 'running', 'waiting', 'failed'] as const)(
    'renews a running %s workspace for six hours and schedules five-hour heartbeat',
    async (status) => {
      const lease = fixture(status)
      await execute(
        Effect.gen(function* () {
          yield* TestClock.setTime(1_000)
          yield* lease.renew()
        }),
      )
      expect(lease.observed()).toEqual({ timeout: 21_600_000, alarms: [18_001_000], cleared: 0 })
    },
  )
  it('cancels completed work without touching its container or destroying its retained workspace', async () => {
    const lease = fixture('completed')
    const container = {
      ...lease.container,
      running: Effect.die('Completed work must not inspect or restart the container'),
    }
    await execute(renewDevelopmentLease('lease-run', lease.store, container, lease.storage))
    expect(lease.observed()).toEqual({ timeout: null, alarms: [], cleared: 1 })
  })
  it.each(['pending', 'running', 'waiting', 'failed'] as const)(
    'does not renew or recreate a stopped %s workspace',
    async (status) => {
      const lease = fixture(status, false)
      await execute(lease.renew())
      expect(lease.observed()).toEqual({ timeout: null, alarms: [], cleared: 1 })
    },
  )
  it('clears an orphan alarm when no active run was saved', async () => {
    const lease = fixture()
    await execute(
      renewDevelopmentLease(
        undefined,
        { getRun: () => Effect.die('No run should be loaded') },
        lease.container,
        lease.storage,
      ),
    )
    expect(lease.observed()).toEqual({ timeout: null, alarms: [], cleared: 1 })
  })
  it('uses current time after delayed or duplicate delivery rather than replaying missed intervals', async () => {
    const lease = fixture()
    await execute(
      Effect.gen(function* () {
        yield* TestClock.setTime(2_000)
        yield* lease.renew()
        yield* TestClock.setTime(50_000_000)
        yield* lease.renew()
      }),
    )
    expect(lease.observed()).toEqual({ timeout: 21_600_000, alarms: [18_002_000, 68_000_000], cleared: 0 })
  })
  it('reads the committed status again after workflow completion and cancels the next heartbeat', async () => {
    const lease = fixture()
    await execute(lease.renew())
    const completed: Pick<StoreService, 'getRun'> = {
      getRun: (runId) => lease.store.getRun(runId).pipe(Effect.map((run) => ({ ...run, status: 'completed' }))),
    }
    await execute(renewDevelopmentLease('lease-run', completed, lease.container, lease.storage))
    expect(lease.observed()).toEqual({ timeout: 21_600_000, alarms: [18_000_000], cleared: 1 })
  })
  it('keeps the already-running workspace when a binding operation fails', async () => {
    const lease = fixture('running')
    const failure = new BindingError({ cause: 'Gateway is not ready after container startup' })
    await expect(execute(Effect.fail(failure).pipe(Effect.ensuring(lease.renew().pipe(Effect.orDie))))).rejects.toEqual(
      failure,
    )
    expect(lease.observed()).toEqual({ timeout: 21_600_000, alarms: [18_000_000], cleared: 0 })
  })
  it('does not schedule a fresh heartbeat when committed run state cannot be read', async () => {
    const lease = fixture()
    const error = new StoreError({ operation: 'getRun', cause: 'D1 unavailable' })
    await expect(
      execute(renewDevelopmentLease('lease-run', { getRun: () => Effect.fail(error) }, lease.container, lease.storage)),
    ).rejects.toEqual(error)
    expect(lease.observed()).toEqual({ timeout: null, alarms: [], cleared: 0 })
  })
})
