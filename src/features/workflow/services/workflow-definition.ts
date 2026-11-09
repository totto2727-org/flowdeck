import { Context, Effect, Schema } from 'effect'

import type { RunId } from '@/features/workflow/domain/identity'
import type { CreateRun, GraphDefinition, JsonObject, WorkflowSummary } from '@/features/workflow/domain/model'

import type { WorkflowFailure } from './failures'

/** Each workflow owns input validation, supported versions, and its initial checkpoint. */
export interface WorkflowDefinition {
  readonly summary: WorkflowSummary
  readonly prepare: (
    input: CreateRun,
  ) => Effect.Effect<{ readonly graph: GraphDefinition; readonly snapshot: JsonObject }, Schema.SchemaError>
}

/** Static execution binding supplied by the application's composition root. */
export type WorkflowExecutor = {
  readonly start: (runId: RunId) => Effect.Effect<void, WorkflowFailure>
  readonly resume: (runId: RunId) => Effect.Effect<void, WorkflowFailure>
}

export interface RegisteredWorkflow extends WorkflowDefinition {
  readonly binding: WorkflowExecutor
}

export class WorkflowRegistry extends Context.Service<WorkflowRegistry, ReadonlyArray<RegisteredWorkflow>>()(
  'flowdeck/WorkflowRegistry',
) {}
