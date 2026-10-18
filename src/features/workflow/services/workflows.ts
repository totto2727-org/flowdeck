import { Context, Effect } from 'effect'

import type { DomainError } from '../domain/errors'
import type { CreateRun, Run, RunDetail, WorkflowSummary } from '../domain/model'

export type WorkflowService<R = never> = {
  readonly listWorkflows: () => Effect.Effect<{ readonly workflows: ReadonlyArray<WorkflowSummary> }, DomainError, R>
  readonly listRuns: () => Effect.Effect<{ readonly runs: ReadonlyArray<Run> }, DomainError, R>
  readonly getRunDetail: (runId: string) => Effect.Effect<RunDetail, DomainError, R>
  readonly createRun: (input: CreateRun) => Effect.Effect<RunDetail, DomainError, R>
  readonly resumeRun: (runId: string) => Effect.Effect<RunDetail, DomainError, R>
}

/** The single application contract between Control and the workflow integration Worker. */
export class Workflows extends Context.Service<Workflows, WorkflowService>()('flowdeck/Workflows') {}
