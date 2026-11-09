import * as BrowserCrypto from '@effect/platform-browser/BrowserCrypto'
import reylo from '@totto2727/reylo/vite'
import { QueryDatabase, QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { makeRpcStub, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Context, Effect, Layer, Schema } from 'effect'

import { D1Client } from '@/features/d1/client'
import { AlchemyQueryExecutorLive } from '@/features/d1/reylo'
import { RunId } from '@/features/workflow/domain/identity'
import { makeRpcResponse } from '@/features/workflow/rpc/boundary'
import {
  RpcCreateRun,
  encodeRunDetail,
  encodeRunsResponse,
  encodeWorkflowsResponse,
  rpcCall,
  rpcCommandResult,
  type WireWorkflowExecutor,
  type WireWorkflowService,
} from '@/features/workflow/rpc/contract'
import { D1StoreLive } from '@/features/workflow/services/d1-store'
import { DatabaseQueriesLive } from '@/features/workflow/services/database-queries'
import { WorkflowRegistry } from '@/features/workflow/services/workflow-definition'
import { Workflows } from '@/features/workflow/services/workflows'

import { Database } from './database'
import { DemoWorkflow, Workflow } from './definitions'
import { DevelopmentWorkflow } from './development-workflow/development-workflow'
import { makeWorkflowRegistry } from './workflow/features/registration'
import { makeWorkflows } from './workflow/features/workflow'
import { DevelopmentWorkflowBinding, WorkflowBinding } from './workflow/features/workflow-binding'

const decodeCreateRun = Schema.decodeUnknownEffect(RpcCreateRun)
const decodeRunId = Schema.decodeUnknownEffect(RunId)

const WorkflowBindingsLive = Layer.effectContext(
  Effect.gen(function* () {
    const environment = yield* WorkerEnvironment
    const demoRpc = makeRpcStub<WireWorkflowExecutor>(environment['DEMO'])
    const developmentRpc = makeRpcStub<WireWorkflowExecutor>(environment['DEVELOPMENT'])
    const demo: WorkflowBinding['Service'] = {
      start: (runId) =>
        demoRpc
          .start(runId)
          .pipe(rpcCall('DemoWorkflow.start'), Effect.flatMap(rpcCommandResult('DemoWorkflow.start'))),
      resume: (runId) =>
        demoRpc
          .resume(runId)
          .pipe(rpcCall('DemoWorkflow.resume'), Effect.flatMap(rpcCommandResult('DemoWorkflow.resume'))),
    }
    const development: DevelopmentWorkflowBinding['Service'] = {
      start: (runId) =>
        developmentRpc
          .start(runId)
          .pipe(rpcCall('DevelopmentWorkflow.start'), Effect.flatMap(rpcCommandResult('DevelopmentWorkflow.start'))),
      resume: (runId) =>
        developmentRpc
          .resume(runId)
          .pipe(rpcCall('DevelopmentWorkflow.resume'), Effect.flatMap(rpcCommandResult('DevelopmentWorkflow.resume'))),
    }
    return Context.make(WorkflowBinding, demo).pipe(Context.add(DevelopmentWorkflowBinding, development))
  }),
)
const WorkflowRegistryLive = Layer.effect(WorkflowRegistry, makeWorkflowRegistry).pipe(
  Layer.provide(WorkflowBindingsLive),
)
const WorkflowDatabaseLive = Layer.effect(
  D1Client,
  Effect.gen(function* () {
    return D1Client.fromBinding(yield* QueryDatabase(yield* Database))
  }),
)
const WorkflowRuntimeLive = Layer.mergeAll(
  Layer.effect(Workflows, makeWorkflows).pipe(
    Layer.provide(
      Layer.mergeAll(
        D1StoreLive.pipe(
          Layer.provide(DatabaseQueriesLive),
          Layer.provide(AlchemyQueryExecutorLive),
          Layer.provide(WorkflowDatabaseLive),
        ),
        WorkflowRegistryLive,
        BrowserCrypto.layer,
      ),
    ),
  ),
  BrowserCrypto.layer,
).pipe(Layer.provide(QueryDatabaseBinding))

/** Catalog, run persistence, and fixed workflow bindings live behind one service. */
export default Workflow.make(
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      build: { input: { plugins: [reylo()] } },
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4384, strictPort: true },
      env: { DEMO: yield* DemoWorkflow, DEVELOPMENT: yield* DevelopmentWorkflow },
    }
  }),
  Effect.gen(function* () {
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
  }).pipe(Effect.provide(WorkflowRuntimeLive)),
)
