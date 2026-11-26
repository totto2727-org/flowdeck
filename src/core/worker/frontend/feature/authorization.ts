import { Effect } from 'effect'
import { HttpMiddleware, HttpServerResponse } from 'effect/http'

import type { AccessDenied } from '@/core/worker/frontend/access-auth'

type ResponseEffect<E, R> = Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
type Authorization<AuthorizationR> = <E, R>(application: ResponseEffect<E, R>) => ResponseEffect<E, R | AuthorizationR>

export const frontendAuthorization = <AuthorizationR>(
  authorize: Effect.Effect<void, AccessDenied, AuthorizationR>,
): Authorization<AuthorizationR> =>
  HttpMiddleware.make(<E, R>(application: ResponseEffect<E, R>) =>
    authorize.pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: error.status })),
        onSuccess: () => application,
      }),
    ),
  )
