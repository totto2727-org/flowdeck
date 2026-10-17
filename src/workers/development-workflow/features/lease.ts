import type { ContainerClient } from 'alchemy/Cloudflare/Containers'
import type { DurableObjectStorage } from 'alchemy/Cloudflare/Workers'
import { Clock, Effect } from 'effect'

import type { StoreService } from '../../../features/workflow/services/store'

/** Renew only a running workspace. This alarm never starts containers or advances SDK turns.
 * Refresh from wall-clock now after restoration or a delayed delivery, without replaying missed renewals. */
export const renewDevelopmentLease = (
  runId: string | undefined,
  store: Pick<StoreService, 'getRun'>,
  container: Pick<ContainerClient, 'running' | 'setInactivityTimeout'>,
  storage: Pick<DurableObjectStorage, 'setAlarm' | 'deleteAlarm'>,
) =>
  Effect.gen(function* () {
    if (runId === undefined) return yield* storage.deleteAlarm()
    const run = yield* store.getRun(runId)
    // Failed runs retain their workspace for inspection until an operator explicitly stops it.
    if (run.status === 'completed' || !(yield* container.running)) return yield* storage.deleteAlarm()
    yield* container.setInactivityTimeout(21_600_000)
    const now = yield* Clock.currentTimeMillis
    yield* storage.setAlarm(now + 18_000_000)
  })
