'use server'

import { Array, Effect, Schema } from 'effect'

import { RunId } from '../../../features/workflow/domain/identity'
import { CreateRun } from '../../../features/workflow/domain/model'
import { ControlApi, type ControlError } from './control-api'
import { EFFRONT } from './effront'
import {
  presentDetail,
  presentRun,
  presentWorkflow,
  type Run,
  type RunDetail,
  type WorkflowSummary,
} from './view-model'

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
  input: Schema.NullOr(RunId),
  handler: (selected: RunId | null) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const [workflows, runs] = yield* Effect.all([api.workflows, api.runs], { concurrency: 2 })
        const detail = selected === null ? null : yield* api.detail(selected)
        return {
          workflows: Array.map(workflows.workflows, (workflow) => presentWorkflow(workflow)),
          runs: Array.map(runs.runs, (run) => presentRun(run)),
          selected: detail === null ? null : presentDetail(detail),
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
