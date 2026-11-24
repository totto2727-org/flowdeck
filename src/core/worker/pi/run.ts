import { DurableObject } from 'alchemy/Cloudflare/Workers'
import type { WebSocket } from 'alchemy/Cloudflare/Workers/WebSocket'
import type { Effect } from 'effect'
import type { HttpServerResponse } from 'effect/http'

import type { WireWorkflowExecutor } from '@/core/feature/workflow/rpc/contract'

type PiRunShape = WireWorkflowExecutor &
  Readonly<{
    fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, never, import('alchemy/Cloudflare/Workers').Request>
    alarm: () => Effect.Effect<void>
    webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) => Effect.Effect<void>
    webSocketClose: (socket: WebSocket, code: number, reason: string, wasClean: boolean) => Effect.Effect<void>
    webSocketError: (socket: WebSocket, error: unknown) => Effect.Effect<void>
  }>

// Preserve the native binding identity used by Computer Workspace.
export class PiRun extends DurableObject<PiRun, PiRunShape>()('DevelopmentRun') {}
