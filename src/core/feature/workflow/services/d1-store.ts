import { Effect, Layer } from 'effect'

import { makeCommit } from './d1-store-commit.ts'
import { makeCreate } from './d1-store-create.ts'
import { makeGetEvents, makeGetGraph, makeGetRun, makeListRuns } from './d1-store-read.ts'
import { Store } from './store.ts'
import type { StoreService } from './store.ts'

export const D1StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const create = yield* makeCreate
    const getRun = yield* makeGetRun
    const listRuns = yield* makeListRuns
    const getGraph = yield* makeGetGraph
    const getEvents = yield* makeGetEvents
    const commit = yield* makeCommit
    return { commit, create, getEvents, getGraph, getRun, listRuns } satisfies StoreService
  }),
)
