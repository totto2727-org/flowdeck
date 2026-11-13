import reylo from '@totto2727/reylo/vite'
import { Effect, Layer } from 'effect'

import { Workflow } from '@/bridge/workflow/core/definition'
import { makeWorkflowRpc } from '@/bridge/workflow/core/feature/rpc'
import { makeWorkflowRuntime } from '@/bridge/workflow/core/feature/runtime'
import { WorkflowBindingsLive, workflowEnvironment } from '@/bridge/workflow/user-land/feature/environment'
import { makeWorkflowRegistry } from '@/bridge/workflow/user-land/feature/registration'
import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'

const WorkflowRegistryLive = Layer.effect(WorkflowRegistry, makeWorkflowRegistry).pipe(
  Layer.provide(WorkflowBindingsLive),
)
const WorkflowRuntimeLive = makeWorkflowRuntime(WorkflowRegistryLive)

/** Catalog, run persistence, and fixed workflow bindings live behind one service. */
export default Workflow.make(
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      build: { input: { plugins: [reylo()] } },
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      workersDev: { enabled: false, previewsEnabled: false },
      dev: { host: '127.0.0.1', port: 4384, strictPort: true },
      env: yield* workflowEnvironment,
    }
  }),
  makeWorkflowRpc.pipe(Effect.provide(WorkflowRuntimeLive)),
)
