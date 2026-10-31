import { Effect, Schema } from 'effect'

import type { DomainError } from '../domain/errors'
import type { RunId } from '../domain/identity'
import { CreateRun, RunDetail, RunsResponse, WorkflowsResponse } from '../domain/model'

export const RpcCreateRun = Schema.toCodecJson(CreateRun)
export const RpcRunDetail = Schema.toCodecJson(RunDetail)
export const RpcRunsResponse = Schema.toCodecJson(RunsResponse)
export const RpcWorkflowsResponse = Schema.toCodecJson(WorkflowsResponse)

/** Native Worker RPC carries encoded values, never domain SemVer prototypes. */
export type WireWorkflowService<R = never> = {
  readonly listWorkflows: () => Effect.Effect<typeof RpcWorkflowsResponse.Encoded, DomainError, R>
  readonly listRuns: () => Effect.Effect<typeof RpcRunsResponse.Encoded, DomainError, R>
  readonly getRunDetail: (runId: RunId) => Effect.Effect<typeof RpcRunDetail.Encoded, DomainError, R>
  readonly createRun: (input: typeof RpcCreateRun.Encoded) => Effect.Effect<typeof RpcRunDetail.Encoded, DomainError, R>
  readonly resumeRun: (runId: RunId) => Effect.Effect<typeof RpcRunDetail.Encoded, DomainError, R>
}
