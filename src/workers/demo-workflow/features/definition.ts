import { Effect, Schema } from 'effect'

import type { WorkflowDefinition } from '../../../features/workflow/services/workflow-definition'
import { demoGraph, demoWorkflow, encodeDemoSnapshot, initialSnapshot } from './demo'
import { DemoCreateRun } from './input'

export { DemoCreateRun, DemoWorkflowVersion } from './input'

const decodeInput = Schema.decodeUnknownEffect(DemoCreateRun)

export const demoDefinition: WorkflowDefinition = {
  summary: demoWorkflow,
  prepare: (input) =>
    decodeInput(input, { onExcessProperty: 'error' }).pipe(
      Effect.flatMap((validated) =>
        encodeDemoSnapshot(initialSnapshot(validated.version)).pipe(
          Effect.map((snapshot) => ({ graph: demoGraph(validated.version), snapshot })),
        ),
      ),
    ),
}
