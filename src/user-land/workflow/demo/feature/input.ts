import { Schema, SemVer } from 'effect'

export const demoVersion1 = SemVer.make({ major: 1, minor: 0, patch: 0 })
export const demoVersion2 = SemVer.make({ major: 2, minor: 0, patch: 0 })

/** Only the two bundled SemVer implementations can create or restore runs. */
// oxlint-disable-next-line eslint/no-redeclare -- Share the Effect schema name with its derived workflow version type.
export const DemoWorkflowVersion = Schema.SemVer.check(
  Schema.makeFilter((version) => SemVer.equals(version, demoVersion1) || SemVer.equals(version, demoVersion2)),
)
export type DemoWorkflowVersion = typeof DemoWorkflowVersion.Type
// oxlint-disable-next-line eslint/no-redeclare -- Share the input schema name with its decoded workflow input type.
export const DemoCreateRun = Schema.Struct({
  version: DemoWorkflowVersion,
  workflowId: Schema.Literal('demo'),
})
export type DemoCreateRun = typeof DemoCreateRun.Type
