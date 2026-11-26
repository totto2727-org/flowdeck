import { Request } from 'alchemy/Cloudflare/Workers'
import type { WebSocket } from 'alchemy/Cloudflare/Workers/WebSocket'
import { Effect } from 'effect'
import { HttpServerResponse } from 'effect/http'

import type { PiSdk } from '@/core/worker/pi/sdk-service'

export const exposeDevelopmentNative = Effect.fn('flowdeck.development.nativeHandlers')((sdk: typeof PiSdk.Service) =>
  Effect.succeed({
    alarm: () => Effect.promise(async () => sdk.lifecycle.alarm()),
    fetch: Request.pipe(
      Effect.flatMap((request) => sdk.fetch(request)),
      // Preserve the native WebSocket upgrade Response and its workerd-owned socket.
      Effect.map((response) => HttpServerResponse.raw(response, { status: response.status })),
    ),
    // oxlint-disable-next-line eslint/max-params -- This callback matches Cloudflare's four-argument WebSocket close event.
    webSocketClose: (socket: WebSocket, code: number, reason: string, wasClean: boolean) =>
      sdk.webSocketClose(socket.ws, code, reason, wasClean),
    webSocketError: (socket: WebSocket, error: unknown) => sdk.webSocketError(socket.ws, error),
    webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) => sdk.webSocketMessage(socket.ws, message),
  }),
)
