import { Effect } from 'effect'
import { HttpMiddleware, HttpServerResponse } from 'effect/http'

import type { AccessDenied } from '../access-auth'

export const frontendAuthorization = <AuthorizationR>(
  authorize: Effect.Effect<undefined, AccessDenied, AuthorizationR>,
) =>
  HttpMiddleware.make(<E, R>(application: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    authorize.pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: error.status })),
        onSuccess: () => application,
      }),
    ),
  )
