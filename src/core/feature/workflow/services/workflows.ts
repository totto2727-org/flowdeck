import { Context, Effect } from 'effect'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import type { CreateRun, Run, RunDetail, WorkflowSummary } from '@/core/feature/workflow/domain/model'

import type { WorkflowFailure } from './failures'

export type WorkflowService<R = never> = {
  readonly listWorkflows: () => Effect.Effect<
    { readonly workflows: ReadonlyArray<WorkflowSummary> },
    WorkflowFailure,
    R
  >
  readonly listRuns: () => Effect.Effect<{ readonly runs: ReadonlyArray<Run> }, WorkflowFailure, R>
  readonly getRunDetail: (runId: RunId) => Effect.Effect<RunDetail, WorkflowFailure, R>
  readonly createRun: (input: CreateRun) => Effect.Effect<RunDetail, WorkflowFailure, R>
  readonly resumeRun: (runId: RunId) => Effect.Effect<RunDetail, WorkflowFailure, R>
}

/** The single application contract between Control and the workflow integration Worker. */
export class Workflows extends Context.Service<Workflows, WorkflowService>()('flowdeck/Workflows') {}
