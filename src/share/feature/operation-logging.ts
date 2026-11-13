import { Cause, Effect } from 'effect'
import { HttpMiddleware, type HttpServerResponse } from 'effect/http'

/** Install once before HTTP error translation so the original cause remains observable. */
export const operationFailureLogging = HttpMiddleware.make(
  <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    // The standard response logger would render an unhandled cause again after this boundary.
    Effect.tapCause(app, (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : HttpMiddleware.withLoggerDisabled(Effect.logError('HTTP operation failed', cause)),
    ),
)
