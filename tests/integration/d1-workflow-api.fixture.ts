import type { Effect } from 'effect'
import { Layer, Predicate } from 'effect'
import { HttpRouter } from 'effect/http'

import { makeWorkflows } from '@/bridge/workflow/core/feature/workflow'
import { makeWorkflowRegistry } from '@/bridge/workflow/user-land/feature/registration'
import { Store } from '@/core/feature/workflow/services/store'
import type { StoreService } from '@/core/feature/workflow/services/store'
import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import type { RegisteredWorkflow } from '@/core/feature/workflow/services/workflow-definition'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { ApiRoutes } from '@/core/worker/control/feature/router'

import { testBinding, testCrypto, unavailableDevelopmentBinding } from './d1-workflow-binding.fixture.ts'

type WebHandler = Readonly<{
  dispose: () => Promise<void>
  handler: (request: Request) => Promise<Response>
}>

export const makeApi = (
  store: StoreService,
  freshStore: Effect.Effect<StoreService>,
  registry?: Readonly<RegisteredWorkflow[]>,
): WebHandler => {
  const bindings = Layer.mergeAll(testBinding(freshStore), unavailableDevelopmentBinding)
  const workflows = Predicate.isNullish(registry)
    ? Layer.effect(WorkflowRegistry, makeWorkflowRegistry).pipe(Layer.provide(bindings))
    : Layer.succeed(WorkflowRegistry, registry)
  const services = Layer.mergeAll(workflows, Layer.succeed(Store, store), testCrypto)
  const work = Layer.effect(Workflows, makeWorkflows).pipe(Layer.provide(services))
  const routes = ApiRoutes.pipe(HttpRouter.provideRequest(work))
  return HttpRouter.toWebHandler(routes)
}
