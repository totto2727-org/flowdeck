'use server'

import { Array, Effect, Predicate, Schema } from 'effect'

import { RunId } from '@/core/feature/workflow/domain/identity'
import { CreateRun } from '@/core/feature/workflow/domain/model'

import { ControlApi } from './control-api.ts'
import type { ControlError } from './control-api.ts'
import { EFFRONT } from './effront.ts'
import { presentDetail, presentRun, presentWorkflow } from './view-model.ts'
import type { Run, RunDetail, WorkflowSummary } from './view-model.ts'

export type DashboardData = Readonly<{
  runs: Readonly<Run[]>
  selected: RunDetail | null
  workflows: Readonly<WorkflowSummary[]>
}>
export type Result<A> = Readonly<{ ok: true; value: A }> | Readonly<{ ok: false; message: string }>

const result = <A, R>(effect: Effect.Effect<A, ControlError, R>): Effect.Effect<Result<A>, never, R> =>
  effect.pipe(
    Effect.map((value): Result<A> => ({ ok: true, value })),
    Effect.catchTag('ControlError', ({ message }) => Effect.succeed<Result<A>>({ message, ok: false })),
  )

// oxlint-disable-next-line unicorn/no-null -- The public Server Function uses null for the unselected dashboard.
const noSelection = null

export const loadDashboard = EFFRONT.ServerFn.make({
  handler: (selected: RunId | null) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const [workflows, runs] = yield* Effect.all([api.workflows, api.runs], { concurrency: 2 })
        const detail = Predicate.isNullish(selected) ? noSelection : yield* api.detail(selected)
        return {
          runs: Array.map(runs.runs, (run) => presentRun(run)),
          selected: Predicate.isNullish(detail) ? noSelection : presentDetail(detail),
          workflows: Array.map(workflows.workflows, (workflow) => presentWorkflow(workflow)),
        } satisfies DashboardData
      }),
    ),
  input: Schema.NullOr(RunId),
})

export const selectRun = EFFRONT.ServerFn.make({
  handler: (runId: RunId) =>
    result(Effect.flatMap(ControlApi, (api) => api.detail(runId)).pipe(Effect.map(presentDetail))),
  input: RunId,
})

export const startRun = EFFRONT.ServerFn.make({
  handler: (input: CreateRun) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const detail = yield* api.start(input)
        const runs = yield* api.runs
        return { detail: presentDetail(detail), runs: Array.map(runs.runs, (run) => presentRun(run)) }
      }),
    ),
  input: Schema.toCodecJson(CreateRun),
})

export const resumeRun = EFFRONT.ServerFn.make({
  handler: (runId: RunId) =>
    result(
      Effect.gen(function* () {
        const api = yield* ControlApi
        const detail = yield* api.resume(runId)
        const runs = yield* api.runs
        return { detail: presentDetail(detail), runs: Array.map(runs.runs, (run) => presentRun(run)) }
      }),
    ),
  input: RunId,
})
