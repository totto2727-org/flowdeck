import { Effect, Layer } from 'effect'

import { makeWorkflows } from '@/bridge/workflow/core/feature/workflow'
import { makeWorkflowRegistry } from '@/bridge/workflow/user-land/feature/registration'
import { DevelopmentWorkflowBinding, WorkflowBinding } from '@/bridge/workflow/user-land/feature/workflow-binding'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { Store } from '@/core/feature/workflow/services/store'
import { WorkflowRegistry } from '@/core/feature/workflow/services/workflow-definition'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { resumeDevelopmentRun, startDevelopmentRun } from '@/user-land/workflow/development/feature/development'

import { developmentApiCrypto } from './development-d1.fixture.ts'
import type { openDevelopmentFixture } from './development-d1.fixture.ts'

type Fixture = Effect.Success<typeof openDevelopmentFixture>

const offline = (): Effect.Effect<never, ExternalError> =>
  Effect.fail(new ExternalError({ cause: 'offline', kind: 'service', operation: 'test binding' }))

export const workflowControlLayer = ({ execute, store }: Fixture): Layer.Layer<Workflows> => {
  const development = Layer.succeed(DevelopmentWorkflowBinding, {
    resume: (runId) => execute(resumeDevelopmentRun(runId)),
    start: (runId) => execute(startDevelopmentRun(runId)),
  })
  const fallback = Layer.succeed(WorkflowBinding, { resume: offline, start: offline })
  const services = Layer.mergeAll(Layer.succeed(Store, store), development, fallback, developmentApiCrypto)
  const registry = Layer.effect(WorkflowRegistry, makeWorkflowRegistry)
  return Layer.effect(Workflows, makeWorkflows).pipe(Layer.provide(registry), Layer.provide(services))
}
