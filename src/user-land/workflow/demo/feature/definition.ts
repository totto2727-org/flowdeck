import { Effect, Schema } from 'effect'

import type { WorkflowDefinition } from '@/core/feature/workflow/services/workflow-definition'

import { demoGraph, demoWorkflow, encodeDemoSnapshot, initialSnapshot } from './demo.ts'
import { DemoCreateRun } from './input.ts'

export { DemoCreateRun, DemoWorkflowVersion } from './input.ts'

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Routing knows the envelope but has not validated the demo's literal workflow ID and allowed fields.
const decodeInput = Schema.decodeUnknownEffect(DemoCreateRun)

export const demoDefinition: WorkflowDefinition = {
  prepare: (input) =>
    decodeInput(input, { onExcessProperty: 'error' }).pipe(
      Effect.flatMap(({ version }) =>
        initialSnapshot(version).pipe(
          Effect.flatMap(encodeDemoSnapshot),
          Effect.map((snapshot) => ({ graph: demoGraph(version), snapshot })),
        ),
      ),
    ),
  summary: demoWorkflow,
}
