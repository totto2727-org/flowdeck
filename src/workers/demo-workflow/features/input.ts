import { Schema, SemVer } from 'effect'

export const demoVersion1 = SemVer.make({ major: 1, minor: 0, patch: 0 })
export const demoVersion2 = SemVer.make({ major: 2, minor: 0, patch: 0 })

/** Only the two bundled SemVer implementations can create or restore runs. */
export const DemoWorkflowVersion = Schema.SemVer.check(
  Schema.makeFilter((version) => SemVer.equals(version, demoVersion1) || SemVer.equals(version, demoVersion2)),
)
export type DemoWorkflowVersion = typeof DemoWorkflowVersion.Type
export const DemoCreateRun = Schema.Struct({
  workflowId: Schema.Literal('demo'),
  version: DemoWorkflowVersion,
})
export type DemoCreateRun = typeof DemoCreateRun.Type
