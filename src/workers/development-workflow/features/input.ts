import { Array, Schema, SemVer, String } from 'effect'

/** Repository policy is expressed on the native URL, not its persistence representation. */
export const PublicRepository = Schema.URL.check(
  Schema.makeFilter((url) => {
    const segments = String.split(url.pathname, '/')
    return (
      String.length(url.href) <= 256 &&
      !String.includes('?')(url.href) &&
      !String.includes('#')(url.href) &&
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      segments.length === 3 &&
      Array.every(Array.drop(segments, 1), (segment) => String.isNonEmpty(segment) && !String.includes('%')(segment))
    )
  }),
)
export const DevelopmentTask = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_000),
  Schema.makeFilter((task) => String.isNonEmpty(String.trim(task))),
)
export const developmentVersion = SemVer.make({ major: 1, minor: 0, patch: 0 })
export const DevelopmentWorkflowVersion = Schema.SemVer.check(
  Schema.makeFilter((version) => SemVer.Equivalence(version, developmentVersion)),
)
export const DevelopmentCreateRun = Schema.Struct({
  workflowId: Schema.Literal('jcode-development'),
  version: DevelopmentWorkflowVersion,
  repository: PublicRepository,
  task: DevelopmentTask,
})
export type DevelopmentCreateRun = typeof DevelopmentCreateRun.Type
