import type { Effect, Schema } from 'effect'
import { Context } from 'effect'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import type { CreateRun, GraphDefinition, JsonObject, WorkflowSummary } from '@/core/feature/workflow/domain/model'

import type { WorkflowFailure } from './failures.ts'

/** Each workflow owns input validation, supported versions, and its initial checkpoint. */
export type WorkflowDefinition = Readonly<{
  summary: WorkflowSummary
  prepare: (
    input: CreateRun,
  ) => Effect.Effect<Readonly<{ graph: GraphDefinition; snapshot: JsonObject }>, Schema.SchemaError>
}>

/** Static execution binding supplied by the application's composition root. */
export type WorkflowExecutor = Readonly<{
  start: (runId: RunId) => Effect.Effect<void, WorkflowFailure>
  resume: (runId: RunId) => Effect.Effect<void, WorkflowFailure>
}>

export type RegisteredWorkflow = WorkflowDefinition & Readonly<{ binding: WorkflowExecutor }>

export class WorkflowRegistry extends Context.Service<WorkflowRegistry, Readonly<RegisteredWorkflow[]>>()(
  'flowdeck/WorkflowRegistry',
) {}
