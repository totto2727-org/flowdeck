import type { RpcCallError, RpcDecodeError } from 'alchemy/Rpc'
import { Effect, Schema } from 'effect'
import { Headers, HttpBody, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { ExternalError, type DomainError } from '../../../features/workflow/domain/errors'
import {
  ApiErrorResponse,
  CreateRun,
  RunDetail,
  RunsResponse,
  WorkflowsResponse,
} from '../../../features/workflow/domain/model'
import { Workflows } from '../../../features/workflow/services/workflows'

type ApiFailure = DomainError | Schema.SchemaError | HttpServerError.HttpServerError | HttpBody.HttpBodyError
const errorResponse = (status: number, error: string, message: string) =>
  HttpServerResponse.schemaJson(ApiErrorResponse)({ error, message }, { status })
const boundary = <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, ApiFailure, R>) =>
  handler.pipe(
    // makeRpcStub preserves the declared service shape, so transport failures need this wider boundary.
    Effect.mapError((error: ApiFailure | RpcCallError | RpcDecodeError) =>
      error._tag === 'RpcCallError' || error._tag === 'RpcDecodeError'
        ? new ExternalError({ operation: 'call workflow worker', cause: error, kind: 'service' })
        : error,
    ),
    Effect.catchTags({
      NotFound: () => errorResponse(404, 'NotFound', 'Run or graph not found'),
      Conflict: () => errorResponse(409, 'Conflict', 'Run changed concurrently or a delivery ID was reused'),
      InvalidOperation: (error) => errorResponse(409, 'InvalidOperation', error.message),
      InvalidSnapshot: () => errorResponse(409, 'InvalidSnapshot', 'Persisted workflow state is invalid'),
      PlatformError: () => errorResponse(500, 'PlatformError', 'Run identity could not be generated'),
      ExternalError: (error) =>
        error.kind === 'storage'
          ? errorResponse(500, 'ExternalError', 'Persistence operation failed')
          : errorResponse(502, 'ExternalError', 'Workflow worker is unavailable. The run remains persisted'),
      SchemaError: () => errorResponse(400, 'InvalidRequest', 'Request does not match the API schema'),
      HttpServerError: () => errorResponse(400, 'InvalidRequest', 'Request body could not be read'),
      HttpBodyError: () => errorResponse(500, 'EncodingError', 'Response could not be encoded'),
    }),
  )
// Control mutations are server-binding/CLI operations, never browser requests.
// Reject Origin before parsing a body, including text/plain no-cors submissions.
const serverMutation = <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, ApiFailure, R>) =>
  boundary(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (Headers.has(request.headers, 'origin')) {
        return yield* errorResponse(403, 'Forbidden', 'Browser-originated control mutations are not allowed')
      }
      return yield* handler
    }),
  )
const runId = HttpRouter.params.pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))),
  Effect.map((params) => params.runId),
)

/** No native Request, Response, fetch, or URL parsing is used in API handlers.
 * The outer Cloudflare worker owns the sole native HTTP bridge. */
export const ApiRoutes = HttpRouter.use((router) =>
  router.addAll([
    HttpRouter.route(
      'GET',
      '/api/workflows',
      boundary(
        Workflows.pipe(
          Effect.flatMap((workflows) => workflows.listWorkflows()),
          Effect.flatMap(HttpServerResponse.schemaJson(WorkflowsResponse)),
        ),
      ),
    ),
    HttpRouter.route(
      'GET',
      '/api/runs',
      boundary(
        Workflows.pipe(
          Effect.flatMap((workflows) => workflows.listRuns()),
          Effect.flatMap(HttpServerResponse.schemaJson(RunsResponse)),
        ),
      ),
    ),
    HttpRouter.route(
      'POST',
      '/api/runs',
      serverMutation(
        Effect.gen(function* () {
          const input = yield* HttpServerRequest.schemaBodyJson(CreateRun, { onExcessProperty: 'error' })
          const workflows = yield* Workflows
          return yield* HttpServerResponse.schemaJson(RunDetail)(yield* workflows.createRun(input), { status: 201 })
        }),
      ),
    ),
    HttpRouter.route(
      'GET',
      '/api/runs/:runId',
      boundary(
        Effect.gen(function* () {
          const workflows = yield* Workflows
          return yield* HttpServerResponse.schemaJson(RunDetail)(yield* workflows.getRunDetail(yield* runId))
        }),
      ),
    ),
    HttpRouter.route(
      'POST',
      '/api/runs/:runId/resume',
      serverMutation(
        Effect.gen(function* () {
          const workflows = yield* Workflows
          return yield* HttpServerResponse.schemaJson(RunDetail)(yield* workflows.resumeRun(yield* runId))
        }),
      ),
    ),
  ]),
)
export const routesLayer = ApiRoutes
