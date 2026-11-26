import { BrowserCrypto } from '@effect/platform-browser'
import { QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { Layer } from 'effect'

import type { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import { Workflows } from '@/core/feature/workflow/services/workflows'

import { WorkflowStoreLive } from './database.ts'
import { makeWorkflows } from './workflow.ts'

type D1Adapter = typeof QueryDatabaseBinding
type WorkflowStore = typeof WorkflowStoreLive

type WorkflowRuntime<E, R> = Layer.Layer<
  Workflows | Layer.Success<typeof BrowserCrypto.layer>,
  E,
  Exclude<R | Layer.Services<WorkflowStore>, Layer.Success<D1Adapter>> | Layer.Services<D1Adapter>
>

// The composition root supplies the installed workflows.
export const makeWorkflowRuntime = <E, R>(registry: Layer.Layer<WorkflowRegistry, E, R>): WorkflowRuntime<E, R> => {
  const dependencies = Layer.mergeAll(WorkflowStoreLive, registry, BrowserCrypto.layer)
  const live = Layer.effect(Workflows, makeWorkflows).pipe(Layer.provide(dependencies))
  return Layer.mergeAll(live, BrowserCrypto.layer).pipe(Layer.provide(QueryDatabaseBinding))
}
