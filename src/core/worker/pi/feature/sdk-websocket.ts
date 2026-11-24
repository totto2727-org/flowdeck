import type { WebSocket as WorkerWebSocket } from '@cloudflare/workers-types'
import type { Lifecycle } from 'agents/lifecycle'
import { Effect } from 'effect'

type CloseEvent = [socket: WorkerWebSocket, code: number, reason: string, wasClean: boolean]

type WebSocketCallbacks = Readonly<{
  webSocketClose: (...event: CloseEvent) => Effect.Effect<void>
  webSocketError: (socket: WorkerWebSocket, error: unknown) => Effect.Effect<void>
  webSocketMessage: (socket: WorkerWebSocket, message: string | ArrayBuffer) => Effect.Effect<void>
}>

type SocketLifecycle = Pick<Lifecycle, keyof WebSocketCallbacks>

const nativeSocket = (socket: WorkerWebSocket): WebSocket =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Alchemy and the SDK give the same workerd socket different declaration types.
  socket as unknown as WebSocket

export const sdkWebSocketEvents = (lifecycle: SocketLifecycle): WebSocketCallbacks => ({
  webSocketClose: (...[socket, ...event]) =>
    Effect.promise(async () => lifecycle.webSocketClose(nativeSocket(socket), ...event)),
  webSocketError: (socket, error) => Effect.promise(async () => lifecycle.webSocketError(nativeSocket(socket), error)),
  webSocketMessage: (socket, message) =>
    Effect.promise(async () => lifecycle.webSocketMessage(nativeSocket(socket), message)),
})
