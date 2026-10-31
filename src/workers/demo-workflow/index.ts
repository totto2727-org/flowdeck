import { QueryDatabase, QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { DurableObject } from 'alchemy/Cloudflare/Workers'
import { Effect } from 'effect'

import type { RunId } from '../../features/workflow/domain/identity'
import { makeD1Store } from '../../features/workflow/services/d1-store'
import { Store } from '../../features/workflow/services/store'
import { Database } from '../database'
import { DemoWorkflow } from '../definitions'
import { resumeRun, startRun } from './features/demo'

/** Each logical run name resolves to one object, but no checkpoint lives in memory. */
export class FlowdeckRun extends DurableObject<FlowdeckRun>()(
  'FlowdeckRun',
  Effect.gen(function* () {
    const database = yield* QueryDatabase(yield* Database)
    return Effect.gen(function* () {
      const store = makeD1Store(yield* database.raw)
      return {
        start: (runId: RunId) =>
          startRun(runId).pipe(Effect.provideService(Store, store), Effect.provide(BrowserCrypto.layer)),
        resume: (runId: RunId) =>
          resumeRun(runId).pipe(Effect.provideService(Store, store), Effect.provide(BrowserCrypto.layer)),
      }
    })
  }).pipe(Effect.provide(QueryDatabaseBinding)),
) {}

/** The entry resolves a run namespace and forwards only the fixed demo operations. */
export default DemoWorkflow.make(
  {
    main: import.meta.url,
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    workersDev: { enabled: false, previewsEnabled: false },
    dev: { host: '127.0.0.1', port: 4382, strictPort: true },
  },
  Effect.gen(function* () {
    const runs = yield* FlowdeckRun
    return {
      start: (runId: RunId) => runs.getByName(runId).start(runId),
      resume: (runId: RunId) => runs.getByName(runId).resume(runId),
    }
  }),
)
import { BrowserCrypto } from '@effect/platform-browser'
