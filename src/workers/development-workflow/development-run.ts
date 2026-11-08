import { DurableObject } from 'alchemy/Cloudflare/Workers'
import type { WebSocket } from 'alchemy/Cloudflare/Workers/WebSocket'
import type { Effect } from 'effect'
import type { HttpServerResponse } from 'effect/http'

import type { WireWorkflowExecutor } from '../../features/workflow/services/workflow-rpc'

type DevelopmentRunShape = WireWorkflowExecutor & {
  readonly fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    import('alchemy/Cloudflare/Workers').Request
  >
  readonly alarm: () => Effect.Effect<void>
  readonly webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) => Effect.Effect<void>
  readonly webSocketClose: (socket: WebSocket, code: number, reason: string, wasClean: boolean) => Effect.Effect<void>
  readonly webSocketError: (socket: WebSocket, error: unknown) => Effect.Effect<void>
}

export class DevelopmentRun extends DurableObject<DevelopmentRun, DevelopmentRunShape>()('DevelopmentRun') {}
