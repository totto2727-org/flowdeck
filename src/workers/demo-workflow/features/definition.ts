import { Effect, Schema } from 'effect'

import type { WorkflowDefinition } from '../../../features/workflow/services/workflow-definition'
import { demoGraph, demoWorkflow, initialSnapshot } from './demo'
import { DemoCreateRun } from './input'

export { DemoCreateRun, DemoWorkflowVersion } from './input'

export const demoDefinition: WorkflowDefinition = {
  summary: demoWorkflow,
  prepare: (input) =>
    Schema.decodeUnknownEffect(DemoCreateRun)(input, { onExcessProperty: 'error' }).pipe(
      Effect.map((validated) => ({
        graph: demoGraph(validated.version),
        snapshot: initialSnapshot(validated.version),
      })),
    ),
}
