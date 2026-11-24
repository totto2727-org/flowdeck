import { Array, Schema, SemVer, String } from 'effect'

const maximumRepositoryUrlLength = 256
const repositoryPathSegments = 3
const leadingSeparatorSegments = 1
const maximumTaskLength = 16_000

/** Repository policy is expressed on the native URL, not its persistence representation. */
export const PublicRepository = Schema.URL.check(
  Schema.makeFilter((url) => {
    const segments = String.split(url.pathname, '/')
    return (
      String.length(url.href) <= maximumRepositoryUrlLength &&
      !String.includes('?')(url.href) &&
      !String.includes('#')(url.href) &&
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      String.isEmpty(url.port) &&
      String.isEmpty(url.username) &&
      String.isEmpty(url.password) &&
      segments.length === repositoryPathSegments &&
      Array.every(
        Array.drop(segments, leadingSeparatorSegments),
        (segment) => String.isNonEmpty(segment) && !String.includes('%')(segment),
      )
    )
  }),
)
export const DevelopmentTask = Schema.String.check(
  Schema.isMaxLength(maximumTaskLength),
  Schema.makeFilter((task) => String.isNonEmpty(String.trim(task))),
)
export const developmentVersion = SemVer.make({ major: 1, minor: 0, patch: 0 })
export const DevelopmentWorkflowVersion = Schema.SemVer.check(
  Schema.makeFilter((version) => SemVer.Equivalence(version, developmentVersion)),
)
// oxlint-disable-next-line eslint/no-redeclare -- Preserve both the workflow input schema and its public type.
export const DevelopmentCreateRun = Schema.Struct({
  repository: PublicRepository,
  task: DevelopmentTask,
  version: DevelopmentWorkflowVersion,
  workflowId: Schema.Literal('jcode-development'),
})
export type DevelopmentCreateRun = typeof DevelopmentCreateRun.Type
