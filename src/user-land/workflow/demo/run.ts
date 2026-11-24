import { QueryDatabaseBinding } from 'alchemy/Cloudflare/D1'
import { DurableObject } from 'alchemy/Cloudflare/Workers'
import { Effect } from 'effect'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import { makeRpcResponse } from '@/core/feature/workflow/rpc/boundary'
import type { WireWorkflowExecutor } from '@/core/feature/workflow/rpc/contract'
import { commandAcknowledgement, decodeRunId } from '@/user-land/workflow/run-wire'

import { DemoExecutor } from './feature/demo.ts'
import { makeDemoRunRuntime } from './run-runtime.ts'

const commands = Effect.gen(function* () {
  const executor = yield* DemoExecutor
  const respond = yield* makeRpcResponse
  return {
    resume: (runId: RunId) =>
      decodeRunId(runId).pipe(
        Effect.flatMap(executor.resume),
        Effect.as(commandAcknowledgement),
        respond('FlowdeckRun.resume'),
      ),
    start: (runId: RunId) =>
      decodeRunId(runId).pipe(
        Effect.flatMap(executor.start),
        Effect.as(commandAcknowledgement),
        respond('FlowdeckRun.start'),
      ),
  } satisfies WireWorkflowExecutor
})

// Alchemy discovers the static D1 binding while constructing the resource.
// The complete layer starts once per durable object activation.
const activate = Effect.gen(function* () {
  const runtime = yield* makeDemoRunRuntime
  return commands.pipe(Effect.provide(runtime))
}).pipe(Effect.provide(QueryDatabaseBinding))

// Each logical run name resolves to one object. Checkpoints live in D1.
export class FlowdeckRun extends DurableObject<FlowdeckRun>()('FlowdeckRun', activate) {}
