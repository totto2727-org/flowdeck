'use server'

import { Array, Effect, Predicate, Schema } from 'effect'

import { RunId } from '@/core/feature/workflow/domain/identity'
import { CreateRun } from '@/core/feature/workflow/domain/model'

import { ControlApi } from './control-api.ts'
import type { ControlError } from './control-api.ts'
import { EFFRONT } from './effront.ts'
import { presentDetail, presentRun, presentWorkflow } from './view-model.ts'
import type { Run, RunDetail, WorkflowSummary } from './view-model.ts'

export interface DashboardData {
  readonly workflows: Readonly<WorkflowSummary[]>
  readonly runs: Readonly<Run[]>
  readonly selected: RunDetail | null
}
export type Result<A> = Readonly<{ ok: true; value: A }> | Readonly<{ ok: false; message: string }>

const result = <A, R>(effect: Effect.Effect<A, ControlError, R>): Effect.Effect<Result<A>, never, R> =>
  effect.pipe(
    Effect.map((value): Result<A> => ({ ok: true, value })),
    Effect.catchTag('ControlError', (error) => Effect.succeed<Result<A>>({ ok: false, message: error.message })),
  )

export const loadDashboard = EFFRONT.ServerFn.make({
  input: Schema.NullOr(RunId),
  handler: (selected: RunId | null) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const [workflows, runs] = yield* Effect.all([api.workflows, api.runs], { concurrency: 2 })
        const detail = Predicate.isNull(selected) ? null : yield* api.detail(selected)
        return {
          workflows: Array.map(workflows.workflows, (workflow) => presentWorkflow(workflow)),
          runs: Array.map(runs.runs, (run) => presentRun(run)),
          selected: Predicate.isNull(detail) ? null : presentDetail(detail),
        } satisfies DashboardData
      }),
    ),
})

export const selectRun = EFFRONT.ServerFn.make({
  input: RunId,
  handler: (runId: RunId) =>
    result(Effect.flatMap(ControlApi, (api) => api.detail(runId)).pipe(Effect.map(presentDetail))),
})

export const startRun = EFFRONT.ServerFn.make({
  input: Schema.toCodecJson(CreateRun),
  handler: (input: CreateRun) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const detail = yield* api.start(input)
        const runs = yield* api.runs
        return { detail: presentDetail(detail), runs: Array.map(runs.runs, (run) => presentRun(run)) }
      }),
    ),
})

export const resumeRun = EFFRONT.ServerFn.make({
  input: RunId,
  handler: (runId: RunId) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const detail = yield* api.resume(runId)
        const runs = yield* api.runs
        return { detail: presentDetail(detail), runs: Array.map(runs.runs, (run) => presentRun(run)) }
      }),
    ),
})
