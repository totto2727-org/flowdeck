import { Effect, Schema } from 'effect'

import type { WorkflowDefinition } from '../../../features/workflow/services/workflow-definition'
import { developmentGraphFor, developmentWorkflow, initialDevelopmentSnapshot } from './development'
import { DevelopmentCreateRun } from './input'

export { DevelopmentCreateRun, DevelopmentTask, PublicRepository } from './input'

export const developmentDefinition: WorkflowDefinition = {
  summary: developmentWorkflow,
  prepare: (input) =>
    Schema.decodeUnknownEffect(DevelopmentCreateRun)(input, { onExcessProperty: 'error' }).pipe(
      Effect.map((validated) => ({
        graph: developmentGraphFor(validated.version),
        snapshot: initialDevelopmentSnapshot(validated),
      })),
    ),
}
