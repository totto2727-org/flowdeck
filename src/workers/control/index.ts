import { makeRpcStub, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Effect, Layer, Schema } from 'effect'
import { HttpRouter } from 'effect/http'

import {
  RpcCreateRun,
  RpcRunDetail,
  RpcRunsResponse,
  RpcWorkflowsResponse,
  type WireWorkflowService,
} from '../../features/workflow/services/workflow-rpc'
import { Workflows } from '../../features/workflow/services/workflows'
import { Control, Workflow } from '../definitions'
import { ApiRoutes } from './features/router'

const decodeWorkflowsResponse = Schema.decodeUnknownEffect(RpcWorkflowsResponse, { onExcessProperty: 'error' })
const decodeRunsResponse = Schema.decodeUnknownEffect(RpcRunsResponse, { onExcessProperty: 'error' })
const decodeRunDetail = Schema.decodeUnknownEffect(RpcRunDetail, { onExcessProperty: 'error' })
const encodeCreateRun = Schema.encodeEffect(RpcCreateRun)

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
  Effect.sync(() => {
    const rpc = makeRpcStub<WireWorkflowService>(
      WorkerEnvironment.pipe(Effect.map((environment) => environment['WORKFLOW'])),
    )
    const workflows: Workflows['Service'] = {
      listWorkflows: () => rpc.listWorkflows().pipe(Effect.flatMap(decodeWorkflowsResponse)),
      listRuns: () => rpc.listRuns().pipe(Effect.flatMap(decodeRunsResponse)),
      getRunDetail: (runId) => rpc.getRunDetail(runId).pipe(Effect.flatMap(decodeRunDetail)),
      createRun: (input) =>
        encodeCreateRun(input).pipe(
          Effect.flatMap((encoded) => rpc.createRun(encoded)),
          Effect.flatMap(decodeRunDetail),
        ),
      resumeRun: (runId) => rpc.resumeRun(runId).pipe(Effect.flatMap(decodeRunDetail)),
    }
    return {
      fetch: Effect.gen(function* () {
        const routes = ApiRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(Workflows, workflows)))
        const http = yield* HttpRouter.toHttpEffect(routes)
        return yield* http
      }).pipe(Effect.orDie),
    }
  }),
)
