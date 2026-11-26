import type { Effect } from 'effect'
import { Context } from 'effect'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import type { CreateRun, Run, RunDetail, WorkflowSummary } from '@/core/feature/workflow/domain/model'

import type { WorkflowFailure } from './failures.ts'

export type WorkflowService<R = never> = Readonly<{
  listWorkflows: () => Effect.Effect<Readonly<{ workflows: Readonly<WorkflowSummary[]> }>, WorkflowFailure, R>
  listRuns: () => Effect.Effect<Readonly<{ runs: Readonly<Run[]> }>, WorkflowFailure, R>
  getRunDetail: (runId: RunId) => Effect.Effect<RunDetail, WorkflowFailure, R>
  createRun: (input: CreateRun) => Effect.Effect<RunDetail, WorkflowFailure, R>
  resumeRun: (runId: RunId) => Effect.Effect<RunDetail, WorkflowFailure, R>
}>

/** The single application contract between Control and the workflow integration Worker. */
export class Workflows extends Context.Service<Workflows, WorkflowService>()('flowdeck/Workflows') {}
