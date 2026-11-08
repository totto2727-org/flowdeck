import * as BrowserCrypto from '@effect/platform-browser/BrowserCrypto'
import reylo from '@totto2727/reylo/vite'
import { QueryDatabase, QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { makeRpcStub, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, Layer, Schema } from 'effect'

import { D1StoreLive } from '../features/workflow/services/d1-store'
import { WorkflowDatabase } from '../features/workflow/services/database'
import { WorkflowRegistry } from '../features/workflow/services/workflow-definition'
import {
  RpcCreateRun,
  RpcRunDetail,
  RpcRunsResponse,
  RpcWorkflowsResponse,
  workflowRpcErrors,
  type WireWorkflowService,
} from '../features/workflow/services/workflow-rpc'
import { Database } from './database'
import { DemoWorkflow, Workflow } from './definitions'
import { DevelopmentWorkflow } from './development-workflow/development-workflow'
import { makeWorkflowRegistry } from './workflow/features/registration'
import { makeWorkflows } from './workflow/features/workflow'
import { DevelopmentWorkflowBinding, WorkflowBinding } from './workflow/features/workflow-binding'

const encodeWorkflowsResponse = Schema.encodeEffect(RpcWorkflowsResponse)
const encodeRunsResponse = Schema.encodeEffect(RpcRunsResponse)
const encodeRunDetail = Schema.encodeEffect(RpcRunDetail)
const decodeCreateRun = Schema.decodeUnknownEffect(RpcCreateRun)

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
    const database = yield* QueryDatabase(yield* Database)
    const demo = makeRpcStub<WorkflowBinding['Service']>(
      WorkerEnvironment.pipe(Effect.map((environment) => environment['DEMO'])),
      { errors: workflowRpcErrors },
    )
    const development = makeRpcStub<DevelopmentWorkflowBinding['Service']>(
      WorkerEnvironment.pipe(Effect.map((environment) => environment['DEVELOPMENT'])),
      { errors: workflowRpcErrors },
    )
    const registry = yield* makeWorkflowRegistry.pipe(
      Effect.provideService(WorkflowBinding, demo),
      Effect.provideService(DevelopmentWorkflowBinding, development),
    )
    const storeLayer = D1StoreLive.pipe(Layer.provide(Layer.succeed(WorkflowDatabase, database)))
    const service = makeWorkflows.pipe(
      Effect.provide(Layer.mergeAll(storeLayer, Layer.succeed(WorkflowRegistry, registry), BrowserCrypto.layer)),
    )
    return {
      listWorkflows: () =>
        service.pipe(
          Effect.flatMap((workflows) => workflows.listWorkflows()),
          Effect.flatMap(encodeWorkflowsResponse),
        ),
      listRuns: () =>
        service.pipe(
          Effect.flatMap((workflows) => workflows.listRuns()),
          Effect.flatMap(encodeRunsResponse),
        ),
      getRunDetail: (runId) =>
        service.pipe(
          Effect.flatMap((workflows) => workflows.getRunDetail(runId)),
          Effect.flatMap(encodeRunDetail),
        ),
      createRun: (input) =>
        decodeCreateRun(input).pipe(
          Effect.flatMap((decoded) => service.pipe(Effect.flatMap((workflows) => workflows.createRun(decoded)))),
          Effect.flatMap(encodeRunDetail),
        ),
      resumeRun: (runId) =>
        service.pipe(
          Effect.flatMap((workflows) => workflows.resumeRun(runId)),
          Effect.flatMap(encodeRunDetail),
        ),
    } satisfies WireWorkflowService<RuntimeContext>
  }).pipe(Effect.provide(QueryDatabaseBinding)),
)
