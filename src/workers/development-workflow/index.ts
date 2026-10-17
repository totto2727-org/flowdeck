import { QueryDatabase, QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { DurableObject, DurableObjectState } from 'alchemy/Cloudflare/Workers'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, Semaphore } from 'effect'

import { makeD1Store } from '../../features/workflow/services/d1-store'
import { Store } from '../../features/workflow/services/store'
import { Database } from '../database'
import { DevelopmentWorkflow } from '../definitions'
import { JcodeContainer, JcodeSandboxLive } from './container'
import { resumeDevelopmentRun, startDevelopmentRun } from './features/development'
import { renewDevelopmentLease } from './features/lease'
import { JcodeSandbox } from './features/sandbox'

/** One run DO owns one native container handle and reuses its SDK session across nodes. */
export class DevelopmentRun extends DurableObject<DevelopmentRun>()(
  'DevelopmentRun',
  Effect.gen(function* () {
    const database = yield* QueryDatabase(yield* Database)
    const sandbox = yield* JcodeSandboxLive
    const container = yield* JcodeContainer
    return Effect.gen(function* () {
      const store = makeD1Store(yield* database.raw)
      const nativeSandbox = yield* JcodeSandbox.pipe(Effect.provide(sandbox))
      const state = yield* DurableObjectState
      const runtime = yield* RuntimeContext
      const lock = yield* Semaphore.make(1)
      const heartbeat = lock
        .withPermit(
          Effect.gen(function* () {
            const runId = yield* state.storage.get<string>('active-run-id')
            yield* renewDevelopmentLease(runId, store, container, state.storage)
          }),
        )
        .pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie)
      // Reconstructed objects renew an existing workspace, but never recreate a stopped one.
      yield* heartbeat
      const execute = (runId: string, operation: ReturnType<typeof startDevelopmentRun>) =>
        Effect.gen(function* () {
          yield* state.storage.put('active-run-id', runId)
          yield* operation
        }).pipe(
          Effect.ensuring(heartbeat),
          Effect.provideService(Store, store),
          Effect.provideService(JcodeSandbox, nativeSandbox),
          Effect.provideService(RuntimeContext, runtime),
        )
      return {
        start: (runId: string) => execute(runId, startDevelopmentRun(runId)),
        resume: (runId: string) => execute(runId, resumeDevelopmentRun(runId)),
        alarm: () => heartbeat,
      }
    })
  }).pipe(Effect.provide(QueryDatabaseBinding)),
) {}

export default DevelopmentWorkflow.make(
  {
    main: import.meta.url,
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    workersDev: { enabled: false, previewsEnabled: false },
    dev: { host: '127.0.0.1', port: 4383, strictPort: true },
  },
  Effect.gen(function* () {
    const runs = yield* DevelopmentRun
    return {
      start: (runId: string) => runs.getByName(runId).start(runId),
      resume: (runId: string) => runs.getByName(runId).resume(runId),
    }
  }),
)
