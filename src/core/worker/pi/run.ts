import { DurableObject } from 'alchemy/Cloudflare/Workers'
import type { Request } from 'alchemy/Cloudflare/Workers'
import type { WebSocket } from 'alchemy/Cloudflare/Workers/WebSocket'
import type { Effect } from 'effect'
import type { HttpServerResponse } from 'effect/http'

import type { WireWorkflowExecutor } from '@/core/feature/workflow/rpc/contract'

type PiRunShape = WireWorkflowExecutor &
  Readonly<{
    fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Request>
    alarm: () => Effect.Effect<void>
    webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) => Effect.Effect<void>
    // oxlint-disable-next-line eslint/max-params -- The native Durable Object close callback supplies these four fields.
    webSocketClose: (socket: WebSocket, code: number, reason: string, wasClean: boolean) => Effect.Effect<void>
    webSocketError: (socket: WebSocket, error: unknown) => Effect.Effect<void>
  }>

// Preserve the native binding identity used by Computer Workspace.
export class PiRun extends DurableObject<PiRun, PiRunShape>()('DevelopmentRun') {}
