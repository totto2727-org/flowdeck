import { Array, Schema } from 'effect'

import { SemanticVersion } from '../../../features/workflow/domain/model'

/** Persisted demo versions remain local to this workflow. */
export const DemoWorkflowVersion = Schema.String.check(
  Schema.makeFilter((version) => Array.contains(['v1', 'v2', '1.0.0', '2.0.0'], version)),
)
export type DemoWorkflowVersion = typeof DemoWorkflowVersion.Type
export const DemoCreateRun = Schema.Struct({
  workflowId: Schema.Literal('demo'),
  version: SemanticVersion.check(Schema.makeFilter((version) => Array.contains(['1.0.0', '2.0.0'], version))),
})
export type DemoCreateRun = typeof DemoCreateRun.Type
