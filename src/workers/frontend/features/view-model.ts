import { Schema, Tuple } from 'effect'

import {
  Run as DomainRun,
  RunDetail as DomainRunDetail,
  RunEvent as DomainRunEvent,
  WorkflowSummary as DomainWorkflowSummary,
} from '../../../features/workflow/domain/model'

// toCodecJson's Encoded type is Json, so compose official string codecs to retain typed DOM fields.
const RunCodec = Schema.Struct({
  ...DomainRun.fields,
  workflowVersion: Schema.SemVerFromString,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
})
const WorkflowCodec = Schema.Struct({
  ...DomainWorkflowSummary.fields,
  versions: Schema.Array(Schema.SemVerFromString),
})
const EventCodec = DomainRunEvent.mapMembers(
  Tuple.map(Schema.fieldsAssign({ createdAt: Schema.DateTimeUtcFromString })),
)
const DetailCodec = Schema.Struct({ ...DomainRunDetail.fields, run: RunCodec, events: Schema.Array(EventCodec) })

/** The view uses official encoded representations without changing the rich domain types. */
export const Run = Schema.toEncoded(RunCodec)
export type Run = typeof Run.Type
export const WorkflowSummary = Schema.toEncoded(WorkflowCodec)
export type WorkflowSummary = typeof WorkflowSummary.Type
export const RunEvent = Schema.toEncoded(EventCodec)
export type RunEvent = typeof RunEvent.Type
export const RunDetail = Schema.toEncoded(DetailCodec)
export type RunDetail = typeof RunDetail.Type

export const presentRun = Schema.encodeSync(RunCodec)
export const presentWorkflow = Schema.encodeSync(WorkflowCodec)
export const presentDetail = Schema.encodeSync(DetailCodec)
