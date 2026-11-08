import { makeRpcStub, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer, Schema } from 'effect'
import { HttpRouter } from 'effect/http'

import {
  RpcCreateRun,
  RpcRunDetail,
  RpcRunsResponse,
  RpcWorkflowsResponse,
  rpcCall,
  rpcValue,
  type WireWorkflowService,
} from '@/features/workflow/services/workflow-rpc'
import { Workflows } from '@/features/workflow/services/workflows'
import { Control, Workflow } from '@/workers/definitions'

import { ApiRoutes } from './features/router'

const decodeWorkflowsResponse = rpcValue('Workflow.listWorkflows', RpcWorkflowsResponse)
const decodeRunsResponse = rpcValue('Workflow.listRuns', RpcRunsResponse)
const decodeGetRunDetail = rpcValue('Workflow.getRunDetail', RpcRunDetail)
const decodeCreatedRun = rpcValue('Workflow.createRun', RpcRunDetail)
const decodeResumedRun = rpcValue('Workflow.resumeRun', RpcRunDetail)
const encodeCreateRun = Schema.encodeEffect(RpcCreateRun)

export const makeControl = Effect.gen(function* () {
  const rpc = makeRpcStub<WireWorkflowService>(
    WorkerEnvironment.pipe(Effect.map((environment) => environment['WORKFLOW'])),
  )
  const workflows: Workflows['Service'] = {
    listWorkflows: () =>
      rpc.listWorkflows().pipe(rpcCall('Workflow.listWorkflows'), Effect.flatMap(decodeWorkflowsResponse)),
    listRuns: () => rpc.listRuns().pipe(rpcCall('Workflow.listRuns'), Effect.flatMap(decodeRunsResponse)),
    getRunDetail: (runId) =>
      rpc.getRunDetail(runId).pipe(rpcCall('Workflow.getRunDetail'), Effect.flatMap(decodeGetRunDetail)),
    createRun: (input) =>
      encodeCreateRun(input).pipe(
        Effect.flatMap((encoded) => rpc.createRun(encoded).pipe(rpcCall('Workflow.createRun'))),
        Effect.flatMap(decodeCreatedRun),
      ),
    resumeRun: (runId) => rpc.resumeRun(runId).pipe(rpcCall('Workflow.resumeRun'), Effect.flatMap(decodeResumedRun)),
  }
  const routes = ApiRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(Workflows, workflows)))
  const http = yield* HttpRouter.toHttpEffect(routes)
  return { fetch: http.pipe(Effect.orDie) }
})

/** Control has one static workflow service binding and no per-workflow configuration. */
export default Control.make(
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4381, strictPort: true },
      env: { WORKFLOW: yield* Workflow },
    }
  }),
  makeControl,
)
