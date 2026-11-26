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
// oxlint-disable-next-line import/no-default-export -- Alchemy's Worker loader requires the deployment resource as the default export.
export default Workflow.make(
  Effect.gen(function* () {
    return {
      build: { input: { plugins: [reylo()] } },
      compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
      dev: { host: '127.0.0.1', port: 4384, strictPort: true },
      env: yield* workflowEnvironment,
      main: import.meta.url,
      workersDev: { enabled: false, previewsEnabled: false },
    }
  }),
  makeWorkflowRpc.pipe(Effect.provide(WorkflowRuntimeLive)),
)
