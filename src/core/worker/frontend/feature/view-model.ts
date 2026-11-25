import { flow, Result, Schema, Tuple } from 'effect'

import {
  Run as DomainRun,
  RunDetail as DomainRunDetail,
  RunEvent as DomainRunEvent,
  WorkflowSummary as DomainWorkflowSummary,
} from '@/core/feature/workflow/domain/model'

// The encoded type returned by toCodecJson is Json. Use string codecs to retain typed DOM fields.
const RunCodec = Schema.Struct({
  ...DomainRun.fields,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  workflowVersion: Schema.SemVerFromString,
})
const WorkflowCodec = Schema.Struct({
  ...DomainWorkflowSummary.fields,
  versions: Schema.Array(Schema.SemVerFromString),
})
const EventCodec = DomainRunEvent.mapMembers(
  Tuple.map(Schema.fieldsAssign({ createdAt: Schema.DateTimeUtcFromString })),
)
const DetailCodec = Schema.Struct({ ...DomainRunDetail.fields, events: Schema.Array(EventCodec), run: RunCodec })

/** The view uses official encoded representations without changing the rich domain types. */
export type Run = typeof RunCodec.Encoded
export type WorkflowSummary = typeof WorkflowCodec.Encoded
export type RunEvent = typeof EventCodec.Encoded
export type RunDetail = typeof DetailCodec.Encoded

export const presentRun = flow(Schema.encodeResult(RunCodec), Result.getOrThrow)
export const presentWorkflow = flow(Schema.encodeResult(WorkflowCodec), Result.getOrThrow)
export const presentDetail = flow(Schema.encodeResult(DetailCodec), Result.getOrThrow)
