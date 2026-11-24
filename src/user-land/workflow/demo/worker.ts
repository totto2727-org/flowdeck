import { BrowserCrypto } from '@effect/platform-browser'
import reylo from '@totto2727/reylo/vite'
import { Effect } from 'effect'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import { makeRpcResponse } from '@/core/feature/workflow/rpc/boundary'
import { rpcCall, rpcCommandResult } from '@/core/feature/workflow/rpc/contract'
import type { WireWorkflowExecutor } from '@/core/feature/workflow/rpc/contract'
import { commandAcknowledgement, decodeRunId } from '@/user-land/workflow/run-wire'

import { DemoWorkflow } from './definition.ts'
import { FlowdeckRun } from './run.ts'

export { FlowdeckRun } from './run.ts'

const entry = Effect.gen(function* () {
  const runs = yield* FlowdeckRun
  const respond = yield* makeRpcResponse
  return {
    resume: (runId: RunId) =>
      decodeRunId(runId).pipe(
        Effect.flatMap((id) => runs.getByName(id).resume(id).pipe(rpcCall('FlowdeckRun.resume'))),
        Effect.flatMap(rpcCommandResult('FlowdeckRun.resume')),
        Effect.as(commandAcknowledgement),
        respond('DemoWorkflow.resume'),
      ),
    start: (runId: RunId) =>
      decodeRunId(runId).pipe(
        Effect.flatMap((id) => runs.getByName(id).start(id).pipe(rpcCall('FlowdeckRun.start'))),
        Effect.flatMap(rpcCommandResult('FlowdeckRun.start')),
        Effect.as(commandAcknowledgement),
        respond('DemoWorkflow.start'),
      ),
  } satisfies WireWorkflowExecutor
})

// oxlint-disable-next-line import/no-default-export -- Alchemy consumes the default workflow Worker entry for this bundle.
export default DemoWorkflow.make(
  {
    build: { input: { plugins: [reylo()] } },
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    dev: { host: '127.0.0.1', port: 4382, strictPort: true },
    main: import.meta.url,
    workersDev: { enabled: false, previewsEnabled: false },
  },
  entry.pipe(Effect.provide(BrowserCrypto.layer)),
)
