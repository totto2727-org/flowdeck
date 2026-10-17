'use server'

import { Effect, Schema } from 'effect'

import { CreateRun } from '../../../features/workflow/domain/model'
import type { Run, RunDetail, WorkflowSummary } from '../../../features/workflow/domain/model'
import { ControlApi, type ControlError } from './control-api'
import { EFFRONT } from './effront'

export interface DashboardData {
  readonly workflows: ReadonlyArray<WorkflowSummary>
  readonly runs: ReadonlyArray<Run>
  readonly selected: RunDetail | null
}
export type Result<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string }

const result = <A, R>(effect: Effect.Effect<A, ControlError, R>) =>
  effect.pipe(
    Effect.map((value): Result<A> => ({ ok: true, value })),
    Effect.catchTag('ControlError', (error) => Effect.succeed<Result<A>>({ ok: false, message: error.message })),
  )

export const loadDashboard = EFFRONT.ServerFn.make({
  input: Schema.NullOr(Schema.String),
  handler: (selected: string | null) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const [workflows, runs] = yield* Effect.all([api.workflows, api.runs], { concurrency: 2 })
        const detail = selected === null ? null : yield* api.detail(selected)
        return { workflows: workflows.workflows, runs: runs.runs, selected: detail } satisfies DashboardData
      }),
    ),
})

export const selectRun = EFFRONT.ServerFn.make({
  input: Schema.String,
  handler: (runId: string) => result(Effect.flatMap(ControlApi, (api) => api.detail(runId))),
})

export const startRun = EFFRONT.ServerFn.make({
  input: CreateRun,
  handler: (input: CreateRun) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const detail = yield* api.start(input)
        const runs = yield* api.runs
        return { detail, runs: runs.runs }
      }),
    ),
})

export const resumeRun = EFFRONT.ServerFn.make({
  input: Schema.String,
  handler: (runId: string) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const detail = yield* api.resume(runId)
        const runs = yield* api.runs
        return { detail, runs: runs.runs }
      }),
    ),
})
