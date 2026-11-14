import { Effect, Schema } from 'effect'

import { RunId } from '@/core/feature/workflow/domain/identity'
import { makeRpcResponse } from '@/core/feature/workflow/rpc/boundary'
import {
  RpcCreateRun,
  encodeRunDetail,
  encodeRunsResponse,
  encodeWorkflowsResponse,
  type WireWorkflowService,
} from '@/core/feature/workflow/rpc/contract'
import { Workflows } from '@/core/feature/workflow/services/workflows'

const decodeCreateRun = Schema.decodeUnknownEffect(RpcCreateRun)
const decodeRunId = Schema.decodeUnknownEffect(RunId)

export const makeWorkflowRpc = Effect.gen(function* () {
  const workflows = yield* Workflows
  const respond = yield* makeRpcResponse
  return {
    listWorkflows: () =>
      workflows.listWorkflows().pipe(Effect.flatMap(encodeWorkflowsResponse), respond('Workflow.listWorkflows')),
    listRuns: () => workflows.listRuns().pipe(Effect.flatMap(encodeRunsResponse), respond('Workflow.listRuns')),
    getRunDetail: (runId) =>
      decodeRunId(runId).pipe(
        Effect.flatMap(workflows.getRunDetail),
        Effect.flatMap(encodeRunDetail),
        respond('Workflow.getRunDetail'),
      ),
    createRun: (input) =>
      decodeCreateRun(input).pipe(
        Effect.flatMap(workflows.createRun),
        Effect.flatMap(encodeRunDetail),
        respond('Workflow.createRun'),
      ),
    resumeRun: (runId) =>
      decodeRunId(runId).pipe(
        Effect.flatMap(workflows.resumeRun),
        Effect.flatMap(encodeRunDetail),
        respond('Workflow.resumeRun'),
      ),
  } satisfies WireWorkflowService
})
