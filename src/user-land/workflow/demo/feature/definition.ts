import { Effect, Schema } from 'effect'

import type { WorkflowDefinition } from '@/core/feature/workflow/services/workflow-definition'

import { demoGraph, demoWorkflow, encodeDemoSnapshot, initialSnapshot } from './demo.ts'
import { DemoCreateRun } from './input.ts'

export { DemoCreateRun, DemoWorkflowVersion } from './input.ts'

const decodeInput = Schema.decodeUnknownEffect(DemoCreateRun)

export const demoDefinition: WorkflowDefinition = {
  summary: demoWorkflow,
  prepare: (input) =>
    decodeInput(input, { onExcessProperty: 'error' }).pipe(
      Effect.flatMap(({ version }) =>
        initialSnapshot(version).pipe(
          Effect.flatMap(encodeDemoSnapshot),
          Effect.map((snapshot) => ({ graph: demoGraph(version), snapshot })),
        ),
      ),
    ),
}
