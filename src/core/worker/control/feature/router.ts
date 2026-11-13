import type { RpcCallError, RpcDecodeError } from 'alchemy/Rpc'
import { Effect, Layer, Match, Schema } from 'effect'
import { Headers, HttpBody, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { RunId } from '@/core/feature/workflow/domain/identity'
import {
  ApiErrorResponse,
  CreateRun,
  RunDetail,
  RunsResponse,
  WorkflowsResponse,
} from '@/core/feature/workflow/domain/model'
import type { WorkflowFailure } from '@/core/feature/workflow/services/failures'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { operationFailureLogging } from '@/share/feature/operation-logging'

type ApiFailure =
  | WorkflowFailure
  | HttpServerError.HttpServerError
  | HttpBody.HttpBodyError
  | RpcCallError
  | RpcDecodeError
const respondApiError = HttpServerResponse.schemaJson(Schema.toCodecJson(ApiErrorResponse))
const respondWorkflows = HttpServerResponse.schemaJson(Schema.toCodecJson(WorkflowsResponse))
const respondRuns = HttpServerResponse.schemaJson(Schema.toCodecJson(RunsResponse))
const respondRunDetail = HttpServerResponse.schemaJson(Schema.toCodecJson(RunDetail))
const decodeRunParams = Schema.decodeUnknownEffect(Schema.Struct({ runId: RunId }))
const createRunBody = HttpServerRequest.schemaBodyJson(Schema.toCodecJson(CreateRun), {
  onExcessProperty: 'error',
})
const errorResponse = (status: number, error: string, message: string) =>
  respondApiError({ error, message }, { status })

const ApiErrors = HttpRouter.middleware<{ handles: ApiFailure }>()((handler) =>
  handler.pipe(
    operationFailureLogging,
    // The RPC client's declared service shape does not include its transport failures.
    Effect.catchTags({
      RpcCallError: (cause) =>
        Effect.fail(new ExternalError({ operation: 'call workflow worker', cause, kind: 'service' })),
      RpcDecodeError: (cause) =>
        Effect.fail(new ExternalError({ operation: 'call workflow worker', cause, kind: 'service' })),
    }),
    Effect.catchTags({
      RemoteWorkerError: (error) =>
        errorResponse(
          error.cause.status,
          Match.value(error.cause.type).pipe(
            Match.when(
              'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#not-found',
              () => 'NotFound',
            ),
            Match.when(
              'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#conflict',
              () => 'Conflict',
            ),
            Match.when(
              'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#invalid-operation',
              () => 'InvalidOperation',
            ),
            Match.when(
              'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#invalid-snapshot',
              () => 'InvalidSnapshot',
            ),
            Match.when(
              'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#invalid-request',
              () => 'InvalidRequest',
            ),
            Match.orElse(() => 'ExternalError'),
          ),
          error.cause.detail,
        ),
      NotFound: () => errorResponse(404, 'NotFound', 'Run or graph not found'),
      Conflict: () => errorResponse(409, 'Conflict', 'Run changed concurrently or a delivery ID was reused'),
      StorageConflict: () => errorResponse(409, 'Conflict', 'Run changed concurrently or a delivery ID was reused'),
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
  ),
)

// Reject browser mutations before body decoding, including text/plain no-cors submissions.
const ServerMutations = HttpRouter.middleware((handler) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method === 'POST' && Headers.has(request.headers, 'origin')) {
      return yield* errorResponse(403, 'Forbidden', 'Browser-originated control mutations are not allowed')
    }
    return yield* handler
  }),
)

const runId = HttpRouter.params.pipe(
  Effect.flatMap(decodeRunParams),
  Effect.map((params) => params.runId),
)

export const ApiRoutes = HttpRouter.use((router) =>
  router.addAll([
    HttpRouter.route(
      'GET',
      '/api/workflows',
      Workflows.pipe(
        Effect.flatMap((workflows) => workflows.listWorkflows()),
        Effect.flatMap(respondWorkflows),
      ),
    ),
    HttpRouter.route(
      'GET',
      '/api/runs',
      Workflows.pipe(
        Effect.flatMap((workflows) => workflows.listRuns()),
        Effect.flatMap(respondRuns),
      ),
    ),
    HttpRouter.route(
      'POST',
      '/api/runs',
      Effect.gen(function* () {
        const input = yield* createRunBody
        const workflows = yield* Workflows
        return yield* respondRunDetail(yield* workflows.createRun(input), {
          status: 201,
        })
      }),
    ),
    HttpRouter.route(
      'GET',
      '/api/runs/:runId',
      Effect.gen(function* () {
        const workflows = yield* Workflows
        return yield* respondRunDetail(yield* workflows.getRunDetail(yield* runId))
      }),
    ),
    HttpRouter.route(
      'POST',
      '/api/runs/:runId/resume',
      Effect.gen(function* () {
        const workflows = yield* Workflows
        return yield* respondRunDetail(yield* workflows.resumeRun(yield* runId))
      }),
    ),
  ]),
).pipe(Layer.provide(ApiErrors.combine(ServerMutations).layer))
export const routesLayer = ApiRoutes
