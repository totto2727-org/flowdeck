import * as BrowserCrypto from '@effect/platform-browser/BrowserCrypto'
import { QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { Layer } from 'effect'

import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import { Workflows } from '@/core/feature/workflow/services/workflows'

import { WorkflowStoreLive } from './database'
import { makeWorkflows } from './workflow'

/** The composition root supplies the installed workflows without coupling the runtime to them. */
export const makeWorkflowRuntime = <E, R>(registry: Layer.Layer<WorkflowRegistry, E, R>) =>
  Layer.mergeAll(
    Layer.effect(Workflows, makeWorkflows).pipe(
      Layer.provide(Layer.mergeAll(WorkflowStoreLive, registry, BrowserCrypto.layer)),
    ),
    BrowserCrypto.layer,
  ).pipe(Layer.provide(QueryDatabaseBinding))
