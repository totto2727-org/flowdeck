import { makeRpcStub, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer, Schema } from 'effect'
import { HttpRouter } from 'effect/http'

import { Workflow } from '@/bridge/workflow/core/definition'
import {
  RpcCreateRun,
  RpcRunDetail,
  RpcRunsResponse,
  RpcWorkflowsResponse,
  rpcCall,
  rpcValue,
} from '@/core/feature/workflow/rpc/contract'
import type { WireWorkflowService } from '@/core/feature/workflow/rpc/contract'
import { Workflows } from '@/core/feature/workflow/services/workflows'

import { Control } from './definition.ts'
import { ApiRoutes } from './feature/router.ts'

const decodeWorkflowsResponse = rpcValue('Workflow.listWorkflows', RpcWorkflowsResponse)
const decodeRunsResponse = rpcValue('Workflow.listRuns', RpcRunsResponse)
const decodeGetRunDetail = rpcValue('Workflow.getRunDetail', RpcRunDetail)
const decodeCreatedRun = rpcValue('Workflow.createRun', RpcRunDetail)
const decodeResumedRun = rpcValue('Workflow.resumeRun', RpcRunDetail)
const encodeCreateRun = Schema.encodeEffect(RpcCreateRun)

export const makeControl = Effect.gen(function* () {
  const rpc = makeRpcStub<WireWorkflowService>(
    WorkerEnvironment.pipe(Effect.map((environment): unknown => environment['WORKFLOW'])),
  )
  const workflows: Workflows['Service'] = {
    createRun: (input) =>
      encodeCreateRun(input).pipe(
        Effect.flatMap((encoded) => rpc.createRun(encoded).pipe(rpcCall('Workflow.createRun'))),
        Effect.flatMap(decodeCreatedRun),
      ),
    getRunDetail: (runId) =>
      rpc.getRunDetail(runId).pipe(rpcCall('Workflow.getRunDetail'), Effect.flatMap(decodeGetRunDetail)),
    listRuns: () => rpc.listRuns().pipe(rpcCall('Workflow.listRuns'), Effect.flatMap(decodeRunsResponse)),
    listWorkflows: () =>
      rpc.listWorkflows().pipe(rpcCall('Workflow.listWorkflows'), Effect.flatMap(decodeWorkflowsResponse)),
    resumeRun: (runId) => rpc.resumeRun(runId).pipe(rpcCall('Workflow.resumeRun'), Effect.flatMap(decodeResumedRun)),
  }
  const routes = ApiRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(Workflows, workflows)))
  const http = yield* HttpRouter.toHttpEffect(routes)
  return { fetch: http.pipe(Effect.orDie) }
})

/** Control has one static workflow service binding and no per-workflow configuration. */
// oxlint-disable-next-line import/no-default-export -- Alchemy discovers the Worker layer through this default entry export.
export default Control.make(
  Effect.gen(function* () {
    return {
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      dev: { host: '127.0.0.1', port: 4381, strictPort: true },
      env: { WORKFLOW: yield* Workflow },
      main: import.meta.url,
      workersDev: { enabled: false, previewsEnabled: false },
    }
  }),
  makeControl,
)
