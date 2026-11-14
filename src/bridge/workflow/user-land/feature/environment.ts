import { makeRpcStub, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Context, Effect, Layer } from 'effect'

import { rpcCall, rpcCommandResult, type WireWorkflowExecutor } from '@/core/feature/workflow/rpc/contract'
import { DemoWorkflow } from '@/user-land/workflow/demo/definition'
import { DevelopmentWorkflow } from '@/user-land/workflow/development/definition'

import { DevelopmentWorkflowBinding, WorkflowBinding } from './workflow-binding'

export const workflowEnvironment = Effect.gen(function* () {
  return { DEMO: yield* DemoWorkflow, DEVELOPMENT: yield* DevelopmentWorkflow }
})

export const WorkflowBindingsLive = Layer.effectContext(
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
