import { Array, Option, Schema, String } from 'effect'

import { WorkflowVersion } from '../../../features/workflow/domain/model'

/** URL is the standard parser boundary. Keep the validated public wire value unchanged. */
export const PublicRepository = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => {
    const parsed = Schema.decodeUnknownOption(Schema.URLFromString)(value)
    if (Option.isNone(parsed)) return false
    const url = parsed.value
    const segments = String.split(url.pathname, '/')
    return (
      value === url.href &&
      !String.includes('?')(value) &&
      !String.includes('#')(value) &&
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
export const DevelopmentWorkflowVersion = Schema.String.check(
  Schema.makeFilter((version) => Array.contains(['v1', '1.0.0'], version)),
)
export const DevelopmentCreateRun = Schema.Struct({
  workflowId: Schema.Literal('jcode-development'),
  version: WorkflowVersion.check(Schema.makeFilter((version) => Array.contains(['1.0.0'], version))),
  repository: PublicRepository,
  task: DevelopmentTask,
})
export type DevelopmentCreateRun = typeof DevelopmentCreateRun.Type
